import { Elements, segment, SendElement } from 'node-karin'

/** Kook 富文本段 */
export type KookSegment =
  | { type: 'text'; content: string }
  | { type: 'at'; target_id: string; role_id?: string }
  | { type: 'image'; src: string }
  | { type: 'voice'; src: string }
  | { type: 'video'; src: string }
  | { type: 'file'; src: string; title?: string }
  | { type: 'mention'; channel_id: string }
  | { type: string;[key: string]: any }

/**
 * Kook content 字段解析:
 * 老版本为纯文本字符串, 新版为 JSON 数组字符串 (富文本段)。
 */
export function parseKookContent (content: string): Array<KookSegment> {
  if (typeof content !== 'string') return [{ type: 'text', content: String(content ?? '') }]
  const trimmed = content.trim()
  if (trimmed.startsWith('[')) {
    try {
      const arr = JSON.parse(trimmed)
      if (Array.isArray(arr)) return arr
    } catch {
      // 解析失败按纯文本处理
    }
  }
  return [{ type: 'text', content }]
}

/** Kook 消息 → Karin */
export function AdapterConvertKarin (content: string): Array<Elements> {
  const segments = parseKookContent(content)
  const elements: Array<Elements> = []
  for (const i of segments) {
    switch (i.type) {
      case 'text':
        elements.push(segment.text(String(i.content ?? '')))
        break
      case 'at':
        // role_id 为角色 @ 或 here 为 @全体, 均无法按用户映射; 数字 id 才转 at
        if (i.role_id) {
          elements.push(segment.text(`@角色${i.role_id}`))
        } else if (i.target_id === 'here' || i.target_id === 'all' || i.target_id === '.all') {
          elements.push(segment.at('all'))
        } else if (/^\d+$/.test(String(i.target_id))) {
          elements.push(segment.at(String(i.target_id)))
        } else {
          elements.push(segment.text((i as any).target_id ? `@${(i as any).target_id}` : '(at)'))
        }
        break
      case 'image':
        elements.push(segment.image(String(i.src)))
        break
      case 'voice':
        elements.push(segment.record(String(i.src)))
        break
      case 'video':
        elements.push(segment.video(String(i.src)))
        break
      case 'file':
        elements.push(segment.file(String(i.src), { name: i.title || '' }))
        break
      default:
        elements.push(segment.text(JSON.stringify(i)))
    }
  }
  return elements
}

/** data: URL 统一转 `base64://` scheme (Kook 图片/文件 src 仅支持 http(s) URL) */
const normalizeUri = (uri: string): string => {
  const match = /^data:[^;,]*;base64,(.+)$/s.exec(uri)
  return match ? `base64://${match[1]}` : uri
}

/**
 * Karin → Kook 转换结果
 * type: 2 图片 / 3 视频 / 4 文件 / 5 音频 / 9 KMarkdown / 10 卡片
 * (官方 /message/create 与 /direct-message/create 的 type 定义)
 */
export type KookConvertResult = {
  /** 消息内容 (原生媒体类型的 URL / KMarkdown 文本) */
  content: string
  /** 卡片消息 (type=10: 文本与媒体混合/多图场景) */
  card?: Record<string, any>
  /** 消息类型 */
  type: 2 | 3 | 4 | 5 | 9 | 10
  /** 引用的消息ID */
  quote?: string
}

/**
 * 媒体资源解析: 一律先经 upload 上传为 Kook 官方 URL。
 * 官方约束: 发送的图片/文件必须由机器人上传, 否则提示"找不到资源" (404)。
 * upload 内部已支持 http(s) URL 下载、base64://、data: URL、本地路径与 Buffer。
 */
const resolveMediaUrl = async (
  src: string,
  kind: 'image' | 'file' | 'audio',
  upload?: (src: string, kind: 'image' | 'file' | 'audio') => Promise<string>
): Promise<string> => {
  const uri = normalizeUri(src)
  if (!uri) return uri
  if (!upload) throw new Error(`媒体需要先上传 (缺少上传能力): ${uri.slice(0, 60)}...`)
  return upload(uri, kind)
}

/**
 * 富文本段 → KMarkdown 纯文本 (type=9 content 发送格式)。
 * 图片 `![名称](url)`; @用户 `(met)id(met)`; @全体 `(met)all(met)`; 频道跳转 `(chn)id(chn)`。
 */
function segmentsToKmarkdown (segments: KookSegment[]): string {
  const parts: string[] = []
  for (const s of segments) {
    switch (s.type) {
      case 'text':
        parts.push(s.content)
        break
      case 'at':
        parts.push(
          s.role_id
            ? `(rol)${s.role_id}(rol)`
            : (s.target_id === 'here' || s.target_id === 'all' ? '(met)all(met)' : `(met)${s.target_id}(met)`)
        )
        break
      case 'image':
        parts.push(`![图片](${s.src})`)
        break
      case 'mention':
        parts.push(`(chn)${s.channel_id}(chn)`)
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

/** 富文本段 + 图片/媒体模块 → 卡片消息对象 (type=10) */
export function buildCard (
  segments: KookSegment[],
  images: string[],
  media: Array<{ type: 'file' | 'audio' | 'video'; src: string; title?: string }>
): Record<string, any> {
  const modules: any[] = []
  const texts: string[] = []
  for (const s of segments) {
    switch (s.type) {
      case 'text':
        texts.push(s.content)
        break
      case 'at':
        texts.push(
          s.role_id
            ? `(rol)${s.role_id}(rol)`
            : (s.target_id === 'here' || s.target_id === 'all' ? '(met)all(met)' : `(met)${s.target_id}(met)`)
        )
        break
      default:
        break
    }
  }
  if (texts.length > 0) modules.push({ type: 'section', text: { type: 'kmarkdown', content: texts.join('\n') } })
  // 卡片模块中无 image/images 类型, 图片必须用 image-group (elements 为 image 元素, 1-9 张)
  if (images.length > 0) {
    for (let i = 0; i < images.length; i += 9) {
      modules.push({
        type: 'image-group',
        elements: images.slice(i, i + 9).map(src => ({ type: 'image', src, alt: '图片' })),
      })
    }
  }
  for (const m of media) {
    if (m.type === 'audio') modules.push({ type: 'audio', src: m.src, title: m.title || '语音' })
    else if (m.type === 'video') modules.push({ type: 'video', src: m.src, title: m.title || '视频' })
    else modules.push({ type: 'file', src: m.src, title: m.title || '文件' })
  }
  return { type: 'card', theme: 'info', modules }
}

/**
 * Karin 消息 → Kook content。
 * 媒体元素 (image/record/video/file) 的 src 一律先经 upload 上传为 Kook URL (官方要求资源必须由机器人上传)。
 * 发送策略 (按官方消息类型定义):
 *  - 纯单张图片        → type=2 图片消息 (content=URL)
 *  - 纯单个视频/文件/音频 → type=3/4/5 (content=URL)
 *  - 纯文本/@          → type=9 KMarkdown
 *  - 文本与媒体混合/多图/多文件 → type=10 卡片 (image-group 元素, 媒体作为卡片元素发送)
 */
export async function KarinConvertAdapter (
  data: Array<SendElement>,
  upload?: (src: string, kind: 'image' | 'file' | 'audio') => Promise<string>
): Promise<KookConvertResult> {
  const segments: KookSegment[] = []
  const images: string[] = []
  const media: Array<{ type: 'file' | 'audio' | 'video'; src: string; title?: string }> = []
  let quote: string | undefined
  for (const i of data) {
    switch (i.type) {
      case 'text':
        segments.push({ type: 'text', content: i.text })
        break
      case 'at':
        if (i.targetId === 'all') segments.push({ type: 'at', target_id: 'here' })
        else segments.push({ type: 'at', target_id: String(i.targetId) })
        break
      case 'reply':
        quote = String(i.messageId)
        break
      case 'image':
        images.push(await resolveMediaUrl(String(i.file), 'image', upload))
        break
      case 'record':
        media.push({ type: 'audio', src: await resolveMediaUrl(String(i.file), 'audio', upload) })
        break
      case 'video':
        media.push({ type: 'video', src: await resolveMediaUrl(String(i.file), 'file', upload) })
        break
      case 'file':
        media.push({ type: 'file', src: await resolveMediaUrl(String(i.file), 'file', upload), title: i.name || undefined })
        break
      default:
        segments.push({ type: 'text', content: JSON.stringify(i) })
    }
  }
  const hasText = segments.length > 0
  // 纯单张图片 → 原生图片消息 (type=2)
  if (images.length === 1 && media.length === 0 && !hasText) {
    return { type: 2, content: images[0], quote }
  }
  // 纯单个媒体 → 原生视频/文件/音频消息 (type=3/4/5)
  if (images.length === 0 && media.length === 1 && !hasText) {
    const m = media[0]
    const t = m.type === 'video' ? 3 : m.type === 'file' ? 4 : 5
    return { type: t, content: m.src, quote }
  }
  // 含文本/多图/多媒体的混合内容 → 卡片消息 (type=10): 图片用 image-group 元素刷新可见状态
  if (images.length > 0 || media.length > 0) {
    return { type: 10, content: '', card: buildCard(segments, images, media), quote }
  }
  // KMarkdown 文本消息 (type=9): 纯文本/@ 拼接为 KMarkdown 语法
  return { type: 9, content: segmentsToKmarkdown(segments), quote }
}