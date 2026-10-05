import { logger, segment } from 'node-karin'
import type { Elements, NodeElement, SendElement } from 'node-karin'
import { detectMedia } from './media'
import { DOWNLOAD_FILE } from './types'
import { msgId } from './common'
import type { WechatClient } from './client'
import type { IlinkItem, IlinkMedia, ItemWithRef, RefMessage } from './types'

/** base64 数据URL */
const b64 = (buffer: Buffer) => `base64://${buffer.toString('base64')}`

/** 下载并解密消息条目中的媒体 */
const downloadItemMedia = async (
  client: WechatClient,
  specific: { media?: IlinkMedia; aeskey?: string } | undefined,
  label: string
): Promise<Buffer> => {
  const param = specific?.media?.encrypt_query_param
  if (!param) throw new Error(`媒体下载参数缺失 (${label})`)
  return client.downloadMedia(param, specific?.aeskey || specific?.media?.aes_key)
}

/** 解析单个消息条目为 karin 元素 */
const parseItem = async (client: WechatClient, item: ItemWithRef): Promise<Elements | null> => {
  switch (item?.type) {
    case 1: {
      const text = item.text_item?.text
      return text ? segment.text(text) : null
    }

    case 2: {
      const buffer = await downloadItemMedia(client, item.image_item, 'image_item')
      const name = `image${detectMedia(buffer).ext || '.jpg'}`
      return segment.image(b64(buffer), { name })
    }

    case 3: {
      const text = item.voice_item?.text
      if (text) return segment.text(text)
      const buffer = await downloadItemMedia(client, item.voice_item, 'voice_item')
      return segment.record(b64(buffer))
    }

    case 4: {
      const name = item.file_item?.file_name || 'file'
      if (!DOWNLOAD_FILE) return segment.text(`[文件: ${name}]`)
      const buffer = await downloadItemMedia(client, item.file_item, 'file_item')
      return segment.file(b64(buffer), { name })
    }

    case 5: {
      const buffer = await downloadItemMedia(client, item.video_item, 'video_item')
      return segment.video(b64(buffer))
    }

    case 11:
    case 12: {
      const name = (item.tool_call_start_item || item.tool_call_result_item)?.tool_name
      return segment.text(`[工具调用: ${name || '未知'}]`)
    }

    default:
      return null
  }
}

/** 解析引用消息链 返回引用消息ID与引用条目 */
const collectRefs = (itemList: Array<ItemWithRef> = []): { messageId: string; items: ItemWithRef[] } => {
  const items: ItemWithRef[] = []
  let messageId = ''

  const walk = (ref?: RefMessage) => {
    if (!ref) return
    if (!messageId) messageId = ref.message_id || ref.msg_id || ref.svr_id || ref.client_id || ''
    const item = ref.message_item
    if (item) {
      items.push(item)
      walk(item.ref_msg)
    }
  }

  for (const item of itemList) walk(item?.ref_msg)
  return { messageId: messageId || msgId(), items }
}

/** 按局部引用元数据截取文本元素 */
const applyPartial = (elements: Elements[], ref: RefMessage): Elements[] => {
  const p = ref.partial_text
  if (!p) return elements
  return elements.map(el =>
    el.type === 'text'
      ? segment.text(String(el.text || '').slice(Number(p.startindex) || 0, Number(p.endindex) || undefined))
      : el
  )
}

/**
 * 解析 ilink 消息条目为 karin 元素
 * @param lookupRef 引用还原 仅携带 svr_id 时从本地缓存取已收到的消息元素
 * @returns 元素数组与引用消息ID
 */
export const parseItems = async (
  client: WechatClient,
  itemList: Array<ItemWithRef> = [],
  lookupRef?: (id: string) => Elements[]
): Promise<{ elements: Elements[]; quoteId: string }> => {
  const quote = collectRefs(itemList)
  const elements: Elements[] = []

  /** 解析条目并追加有效元素 */
  const append = async (items: ItemWithRef[]): Promise<void> => {
    for (const item of items) {
      const element = await parseItem(client, item)
      if (element) elements.push(element)
    }
  }

  if (quote.items.length) {
    elements.push(segment.reply(quote.messageId))
    await append([...quote.items, ...itemList])
  } else if (lookupRef) {
    /** 新版客户端引用只携带 svr_id 从本地缓存还原引用内容 */
    const cached = applyPartial(lookupRef(quote.messageId), itemList[0]?.ref_msg || {})
    if (cached.length) {
      elements.push(segment.reply(quote.messageId))
      elements.push(...cached)
    }
    await append(itemList)
    return { elements, quoteId: quote.messageId }
  } else {
    await append(itemList)
  }

  return { elements, quoteId: quote.items.length ? quote.messageId : '' }
}

/** 文本条目 */
const textItem = (text: string): IlinkItem => ({ type: 1, text_item: { text } })

/** 上传媒体文件并构建消息条目 */
const uploadElement = async (
  client: WechatClient,
  peerId: string,
  file: string,
  kind: 'image' | 'video' | 'file',
  fileName = ''
): Promise<IlinkItem> => {
  const result = await client.uploadMedia(file, peerId, kind, fileName)
  switch (kind) {
    case 'image':
      return { type: 2, image_item: { media: result.media, mid_size: result.fileSize } }
    case 'video':
      return { type: 5, video_item: { media: result.media, video_size: result.fileSize } }
    default:
      return { type: 4, file_item: { media: result.media, file_name: result.fileName, len: String(result.rawSize) } }
  }
}

/** 从转发节点中提取待发送元素 */
export const nodeElements = (node: NodeElement): Elements[] => {
  if (node.subType !== 'fake') return []
  return (node.message ?? []).map(element =>
    typeof element === 'string' ? segment.text(element) : element
  ) as Elements[]
}

/**
 * karin 元素转 ilink 消息条目批次
 * 文本合并为一批 多媒体各自一批 保持顺序
 */
export const toBatches = async (
  client: WechatClient,
  peerId: string,
  elements: Array<SendElement>,
  nodes: NodeElement[] = []
): Promise<{ batches: Array<IlinkItem[]>; nodes: NodeElement[] }> => {
  const batches: Array<IlinkItem[]> = []
  const nodeQueue = [...nodes]
  const texts: string[] = []

  const flush = () => {
    const text = texts.join('').trim()
    if (text) batches.push([textItem(text)])
    texts.length = 0
  }

  /** 上传媒体并入批 失败仅记录日志不发送占位消息 */
  const pushUpload = async (file: string, name: string | undefined, kind: 'image' | 'video' | 'file', label: string, fallback = ''): Promise<void> => {
    flush()
    try {
      batches.push([await uploadElement(client, peerId, file, kind, name || fallback)])
    } catch (error) {
      logger.error(`[wxoc] ${label}上传失败: ${(error as Error).message}`)
    }
  }

  for (const element of elements) {
    switch (element?.type) {
      case 'text':
        texts.push(element.text)
        break

      /** 微信客户端可渲染 markdown 直接作为文本发送 */
      case 'markdown':
        texts.push(element.markdown)
        break

      case 'image':
        await pushUpload(element.file, element.name, 'image', '图片')
        break

      case 'video':
        await pushUpload(element.file, element.name, 'video', '视频')
        break

      case 'file':
        await pushUpload(element.file, element.name, 'file', '文件')
        break

      case 'record':
        await pushUpload(element.file, element.name, 'file', '语音', 'voice.amr')
        break

      case 'node':
        flush()
        nodeQueue.push(element)
        break

      // at/reply/face/button 等微信Claw不支持 忽略
      default:
        break
    }
  }

  flush()
  return { batches, nodes: nodeQueue }
}
