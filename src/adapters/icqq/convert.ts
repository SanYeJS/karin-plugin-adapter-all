import {
  genDmMessageId,
  genGroupMessageId,
  parseDmMessageId,
  parseGroupMessageId,
  segment,
} from '@icqqjs/icqq'
import type { ForwardMessage, GroupMessage, Message, MessageElem, PrivateMessage, Quotable, Sendable } from '@icqqjs/icqq'
import { Contact, Elements, segment as KarinSegment, SendElement } from 'node-karin'

/** icqq bot 提供给段转换层的能力 (避免与主类循环依赖) */
export interface ConvertCtx {
  getFileUrl (contact: Contact, fileId: string): Promise<string>
}

/**
 * 把 icqq 元素的消息 id(群/私聊 cqhttp 字符串) 解析成可引用的 Quotable
 * 用于 Karin reply 段 → icqq 引用回复
 */
export const parseQuotable = (messageId: string): Quotable | undefined => {
  try {
    if (messageId.includes('group')) {
      const info = parseGroupMessageId(messageId)
      return { user_id: info.user_id, time: info.time, seq: info.seq, rand: info.rand, message: '' }
    }
    const info = parseDmMessageId(messageId)
    return { user_id: info.user_id, time: info.time, seq: info.seq, rand: info.rand, message: '' }
  } catch {
    return undefined
  }
}

/** 根据消息上下文 + 引用信息生成 Karin reply 所需的 cqhttp message_id */
const encodeQuoteMsgId = (message: Message | ForwardMessage, q: Quotable): string => {
  if ((message as GroupMessage).message_type === 'group') {
    return genGroupMessageId((message as GroupMessage).group_id, q.user_id, q.seq, q.rand, q.time)
  }
  return genDmMessageId(q.user_id, q.seq, q.rand, q.time)
}

/** icqq 收到的消息 转 Karin Elements */
export async function AdapterConvertKarin (message: Message | ForwardMessage, bot: ConvertCtx): Promise<Array<Elements>> {
  const elements: Array<Elements> = []
  for (const i of message.message) {
    switch (i.type) {
      case 'text':
        elements.push(KarinSegment.text(i.text))
        break
      case 'at':
        // icqq 收到时 qq 为数字或 'all'
        if (i.qq === 'all') {
          elements.push(KarinSegment.at('all'))
        } else {
          elements.push(KarinSegment.at(String(i.qq), i.text))
        }
        break
      case 'face':
      case 'sface':
        elements.push(KarinSegment.face(i.id))
        break
      case 'image':
        // 接收时 url 有效; 历史消息可能只有 file(md5/本地缓存)
        elements.push(KarinSegment.image(i.url || String(i.file), {
          width: i.width,
          height: i.height,
          summary: i.summary,
        }))
        break
      case 'record':
        elements.push(KarinSegment.record(i.url || String(i.file)))
        break
      case 'video':
        elements.push(KarinSegment.video(String(i.file), { width: i.width, height: i.height }))
        break
      case 'flash':
        elements.push(KarinSegment.image(i.url || String(i.file)))
        break
      case 'json':
        elements.push(KarinSegment.json(typeof i.data === 'string' ? i.data : JSON.stringify(i.data)))
        break
      case 'xml':
        elements.push(KarinSegment.xml(String(i.data ?? '')))
        break
      case 'markdown':
        elements.push(KarinSegment.markdown(i.content))
        break
      case 'reply':
        // cqhttp 旧版引用: id 为已编码的 message_id
        elements.push(KarinSegment.reply(i.id))
        break
      case 'quote': {
        // 收到的引用回复: 用消息上下文编码出 message_id
        const mid = encodeQuoteMsgId(message, i)
        elements.push(KarinSegment.reply(mid))
        break
      }
      case 'file': {
        if (i.fid) {
          const msg = message as PrivateMessage | GroupMessage | ForwardMessage
          const scene = msg.message_type === 'private' ? 'friend' : 'group'
          const peer = scene === 'friend'
            ? String((msg as PrivateMessage).from_id ?? msg.user_id)
            : String((msg as GroupMessage).group_id ?? msg.user_id)
          const contact = scene === 'friend' ? {
            scene: 'friend' as const,
            peer,
            subId: {},
            name: '',
          } : {
            scene: 'group' as const,
            peer,
            subId: {},
            name: '',
          }
          const url = await bot.getFileUrl(contact as Contact, String(i.fid))
          elements.push(KarinSegment.file(url, {
            fid: String(i.fid),
            name: i.name || '',
            size: i.size,
          }))
        } else {
          elements.push(KarinSegment.text(`[文件 ${i.name || ''}]`))
        }
        break
      }
      case 'long_msg':
      case 'multimsg':
        elements.push(KarinSegment.text('[合并转发]'))
        break
      case 'poke':
        elements.push(KarinSegment.text(`[戳一戳 ${i.text || ''}]`))
        break
      case 'rps':
        elements.push(KarinSegment.text('[猜拳]'))
        break
      case 'dice':
        elements.push(KarinSegment.text('[骰子]'))
        break
      case 'share':
        elements.push(KarinSegment.text(`[分享 ${i.title || ''}]`))
        break
      case 'location':
        elements.push(KarinSegment.text(`[位置 ${i.address || ''}]`))
        break
      case 'bface':
      case 'mirai':
      case 'button':
      case 'bubble':
      case 'forum':
      default:
        elements.push(KarinSegment.text(JSON.stringify(i)))
    }
  }
  return elements
}

/**
 * data: URL 统一转 `base64://` scheme。
 * icqq 的 uri 仅支持 http(s):// file:// base64:// 三种格式
 */
const normalizeUri = (uri: string): string => {
  const match = /^data:[^;,]*;base64,(.+)$/s.exec(uri)
  return match ? `base64://${match[1]}` : uri
}

/** Karin 发送元素 转 icqq Sendable (+ 引用 source) */
export interface KarinConvertResult {
  message: Sendable
  source?: Quotable
}

export async function KarinConvertAdapter (data: Array<SendElement>): Promise<KarinConvertResult> {
  const message: Array<string | MessageElem> = []
  let source: Quotable | undefined
  for (const i of data) {
    switch (i.type) {
      case 'text':
        message.push(i.text)
        break
      case 'at':
        if (i.targetId === 'all' || String(i.targetId) === 'all') {
          message.push(segment.at('all'))
        } else {
          message.push(segment.at(Number(i.targetId)))
        }
        break
      case 'face':
        message.push(segment.face(i.id))
        break
      case 'reply':
        // 引用回复: 解析出 Quotable 作为 sendMsg 的 source
        source = parseQuotable(i.messageId) || source
        break
      case 'image':
        message.push(segment.image(normalizeUri(i.file)))
        break
      case 'record':
        message.push(segment.record(normalizeUri(i.file)))
        break
      case 'video':
        message.push(segment.video(normalizeUri(i.file)))
        break
      case 'file':
        // icqq 的 FileElem 元素 (发送时触发上传)
        message.push({ type: 'file', file: normalizeUri(i.file), name: i.name || '' })
        break
      case 'json':
        message.push(segment.json(parseJson(i.data)))
        break
      case 'xml':
        message.push(segment.xml(i.data))
        break
      case 'markdown':
        message.push(segment.markdown(i.markdown))
        break
      case 'marketFace':
        // icqq 无商城表情段, 退化为表情
        message.push(segment.face(Number(i.id)))
        break
      default:
        message.push(JSON.stringify(i))
    }
  }
  return { message, source }
}

/** icqq 的 json 元素 data 需要对象, Karin 传的是字符串 */
const parseJson = (data: string): any => {
  try {
    return JSON.parse(data)
  } catch {
    return data
  }
}