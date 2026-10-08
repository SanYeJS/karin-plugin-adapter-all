import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { Elements, karinToQQBot, segment, SendElement } from 'node-karin'
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
  /** 引用的源消息 id (reply 段: 被动回复 msg_id + 引用气泡 message_reference) */
  msgId?: string
  /**
   * Markdown 内容 (msg_type=2):
   *  - content 形式: { content: '## 标题' }
   *  - 模板形式: { templateId: 'xxx', params: [{ key, values }] } → custom_template_id + params
   */
  markdown?: { content?: string; templateId?: string; params?: Array<{ key: string; values: string[] }> }
  /** 内嵌键盘 (官方 keyboard.content 结构: rows 每项 { buttons: [...] }, 由 node-karin 官方 karinToQQBot 转换) */
  keyboard?: { rows: Array<{ buttons: Array<Record<string, any>> }> }
}

/**
 * 解析媒体元素: 仅支持 http(s) URL 或 base64:// 数据 (平台上传接口 url / file_data 二选一);
 * 本地素材 (file:// 前缀 / 绝对路径 / Buffer) 读取为 base64 走平台 file_data 上传 (官方适配器同款 readFile 兜底)
 */
export async function resolveMedia (file?: string | Buffer): Promise<{ url: string; fileData?: string } | undefined> {
  if (Buffer.isBuffer(file)) {
    const data = file.toString('base64')
    return data ? { url: '', fileData: data } : undefined
  }
  const raw = String(file || '')
  if (/^https?:\/\//.test(raw)) return { url: raw }
  if (raw.startsWith('base64://')) {
    let data = raw.slice('base64://'.length)
    // 兼容 "data:image/png;base64,xxx" / "image/png;base64,xxx" 形式
    const idx = data.indexOf(';base64,')
    if (idx >= 0) data = data.slice(idx + ';base64,'.length)
    if (data) return { url: '', fileData: data }
    return undefined
  }
  // 本地文件: file:// 前缀或绝对路径
  const local = raw.startsWith('file://') ? raw.slice('file://'.length) : (isAbsolute(raw) && /^[\w\\/.:-]+\.[\w]{1,6}$/.test(raw) ? raw : '')
  if (!local) return undefined
  try {
    const data = await readFile(local, 'base64')
    return data ? { url: '', fileData: data } : undefined
  } catch {
    return undefined
  }
}

/** Karin 消息 → QQBot (text/at/reply/image/record/video/file/face/markdown/markdownTpl/button/keyboard) */
export async function KarinConvertAdapter (data: Array<SendElement>): Promise<QqBotOutMessage> {
  let content = ''
  const medias: Array<{ url: string; kind: QqBotMediaKind; fileData?: string }> = []
  let msgId: string | undefined
  let markdown: QqBotOutMessage['markdown']
  let keyboard: QqBotOutMessage['keyboard']
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
        const m = await resolveMedia(i.file as string)
        if (m) medias.push({ ...m, kind: 'image' })
        else content += '[图片]'
        break
      }
      case 'record': {
        const m = await resolveMedia(i.file as string)
        if (m) medias.push({ ...m, kind: 'record' })
        else content += '[语音]'
        break
      }
      case 'video': {
        const m = await resolveMedia(i.file as string)
        if (m) medias.push({ ...m, kind: 'video' })
        else content += '[视频]'
        break
      }
      case 'file': {
        const m = await resolveMedia(i.file as string)
        if (m) medias.push({ ...m, kind: 'file' })
        else content += '[文件]'
        break
      }
      case 'face':
        content += '[表情]'
        break
      case 'markdown': {
        let md = String((i as any).markdown ?? '')
        // markdown 内嵌本地图片 (file:// / 绝对路径): 平台仅渲染白名单域名图片, 本地路径无法展示
        // → 提取转富媒体消息发送 (官方适配器「图片进不了 markdown 通道改走富媒体」同款降级)
        const locals: string[] = []
        md = md.replace(/!\[[^\]]*\]\((file:\/\/[^)\s]+|\/[^)\s]+|\\\\[^)\s]+)\)/g, (_all, src: string) => {
          locals.push(src)
          return ''
        })
        for (const src of locals) {
          const m = await resolveMedia(src)
          if (m) medias.push({ ...m, kind: 'image' })
        }
        // 多段 markdown 取最后一段 (v2 每条消息仅支持一个 markdown)
        markdown = { content: md }
        break
      }
      case 'markdownTpl':
        markdown = { templateId: String((i as any).templateId || ''), params: ((i as any).params || []).map((p: { key: string; values: string[] }) => ({ key: String(p.key || ''), values: (p.values || []).map(String) })) }
        break
      case 'button':
      case 'keyboard': {
        // node-karin 官方转换 (karinToQQBot): 完整映射权限 (list/admin)、样式、反引号等,
        // 输出官方 rows 结构 [{ buttons: [...] }]; 按钮插件语义与官方适配器 (karinToQQBot) 完全一致
        const out = karinToQQBot(i as any)
        if (!out.length) break
        // 官方要求按钮 id 在同一 keyboard 内唯一, 重写为序号 (官方 normalizeQQBotButton 同款做法)
        let btnId = 0
        for (const row of out) {
          for (const b of row.buttons) b.id = String(btnId++)
        }
        // 官方 keyboard 上限 5 行, 超出截断
        keyboard = { rows: [...(keyboard?.rows || []), ...out].slice(0, 5) }
        break
      }
      case 'node':
      case 'longMsg':
        content += '[合并转发]'
        break
      case 'json':
      case 'xml':
      case 'pasmsg':
      case 'raw':
        break
      default:
        content += `[${i.type}]`
        break
    }
  }
  return { content, medias, msgId, markdown, keyboard }
}