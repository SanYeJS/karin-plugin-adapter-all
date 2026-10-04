import { Elements, segment, SendElement } from 'node-karin'

/** QQBot content 纯文本中间段 (at 提及形如 <@!openid>/<@openid>) */
export type QqBotContentSegment =
  | { type: 'text'; text: string }
  | { type: 'at'; targetId: string }

/**
 * 解析 QQBot content:
 * 为纯文本字符串, 提及/全体已内联其中, 用正则拆分为 text/at 段。
 */
export function parseQqBotContent (content: string): Array<QqBotContentSegment> {
  const str = String(content ?? '')
  if (!str) return [{ type: 'text', text: '' }]
  const parts: Array<QqBotContentSegment> = []
  const regex = /<@!?([^>\s]+)>/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = regex.exec(str))) {
    if (m.index > last) parts.push({ type: 'text', text: str.slice(last, m.index) })
    const id = String(m[1]).trim()
    if (id === 'all' || id === 'everyone') parts.push({ type: 'at', targetId: 'all' })
    else parts.push({ type: 'at', targetId: id })
    last = m.index + m[0].length
  }
  if (last < str.length) parts.push({ type: 'text', text: str.slice(last) })
  return parts.length ? parts : [{ type: 'text', text: str }]
}

/** QQBot 消息 → Karin (content 提及 + attachments 富媒体) */
export function AdapterConvertKarin (content: string, raw?: { attachments?: Array<{ url?: string; content_type?: string }> }): Array<Elements> {
  const elements: Array<Elements> = []
  for (const i of parseQqBotContent(content)) {
    if (i.type === 'at') {
      elements.push(i.targetId === 'all' ? segment.at('all') : segment.at(i.targetId))
    } else {
      elements.push(segment.text(i.text))
    }
  }
  for (const att of raw?.attachments || []) {
    if (!att.url) continue
    const type = String(att.content_type || '')
    if (type.startsWith('image/')) elements.push(segment.image(att.url))
    else if (type.startsWith('audio/')) elements.push(segment.record(att.url))
    else if (type.startsWith('video/')) elements.push(segment.video(att.url))
    else elements.push(segment.file(att.url))
  }
  return elements
}

/** 平台媒体类型标识 (file_type 上传与发送判断依据) */
export type QqBotMediaKind = 'image' | 'video' | 'record' | 'file'

/** Karin 消息 → QQBot 发送中间结构 (最终 body 由 index 按场景组装) */
export interface QqBotOutMessage {
  /** 文本内容 (at 已转为 <@!openid>) */
  content: string
  /** 富媒体资源列表: http(s) URL 素材上传 url; 本地 base64 素材走 file_data 上传 */
  medias: Array<{ url: string; kind: QqBotMediaKind; fileData?: string }>
  /** 引用的源消息 id (reply 段) */
  msgId?: string
}

/** 解析媒体元素: 仅支持 http(s) URL 或 base64:// 数据 (平台上传接口 url / file_data 二选一) */
function mediaSource (file?: string): { url: string; fileData?: string } | undefined {
  const raw = String(file || '')
  if (/^https?:\/\//.test(raw)) return { url: raw }
  if (raw.startsWith('base64://')) {
    let data = raw.slice('base64://'.length)
    // 兼容 "data:image/png;base64,xxx" / "image/png;base64,xxx" 形式
    const idx = data.indexOf(';base64,')
    if (idx >= 0) data = data.slice(idx + ';base64,'.length)
    if (data) return { url: '', fileData: data }
  }
  return undefined
}

/** Karin 消息 → QQBot (text/at/reply/image/record/video/file/face) */
export async function KarinConvertAdapter (data: Array<SendElement>): Promise<QqBotOutMessage> {
  let content = ''
  const medias: Array<{ url: string; kind: QqBotMediaKind; fileData?: string }> = []
  let msgId: string | undefined
  for (const i of data) {
    switch (i.type) {
      case 'text':
        content += i.text
        break
      case 'at':
        content += i.targetId === 'all' ? '@全体' : `<@!${String(i.targetId)}>`
        break
      case 'reply':
        msgId = String(i.messageId)
        break
      case 'image': {
        const m = mediaSource(i.file)
        if (m) medias.push({ ...m, kind: 'image' })
        else content += '[图片]'
        break
      }
      case 'record': {
        const m = mediaSource(i.file)
        if (m) medias.push({ ...m, kind: 'record' })
        else content += '[语音]'
        break
      }
      case 'video': {
        const m = mediaSource(i.file)
        if (m) medias.push({ ...m, kind: 'video' })
        else content += '[视频]'
        break
      }
      case 'file': {
        const m = mediaSource(i.file)
        if (m) medias.push({ ...m, kind: 'file' })
        else content += '[文件]'
        break
      }
      case 'face':
        content += '[表情]'
        break
      default:
        content += JSON.stringify(i)
    }
  }
  return { content, medias, msgId }
}