/**
 * 微信 Claw (ilink 协议) 类型定义与默认常量
 */

/** iLink API 默认地址 */
export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'
/** CDN 默认地址 */
export const DEFAULT_CDN_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'
/** 机器人类型 */
export const BOT_TYPE = '3'
/** API 超时 (ms) */
export const API_TIMEOUT = 15000
/** 长轮询超时 (ms) */
export const LONG_POLL_TIMEOUT = 35000
/** 出站媒体大小上限 (MB) */
export const MEDIA_MAX_SIZE_MB = 100
/** 接收文件是否自动下载 */
export const DOWNLOAD_FILE = true
/** 正在输入续期间隔 (ms) */
export const TYPING_KEEPALIVE = 5000
/** 正在输入 ticket 有效期 (ms) */
export const TYPING_TICKET_TTL = 60000
/** 正在输入最长持续时间 (ms) */
export const TYPING_TTL = 180000

/** 媒体加密信息 */
export interface IlinkMedia {
  /** 加密查询参数 */
  encrypt_query_param: string
  /** AES 密钥 (base64) */
  aes_key: string
  /** 加密类型 */
  encrypt_type: number
}

/** 文本条目 */
export interface TextItem {
  type: 1
  text_item: { text: string }
}

/** 图片条目 */
export interface ImageItem {
  type: 2
  image_item: { media: IlinkMedia; mid_size: number }
}

/** 语音条目 */
export interface VoiceItem {
  type: 3
  voice_item: { media?: IlinkMedia; text?: string }
}

/** 文件条目 */
export interface FileItem {
  type: 4
  file_item: { media: IlinkMedia; file_name: string; len: string }
}

/** 视频条目 */
export interface VideoItem {
  type: 5
  video_item: { media: IlinkMedia; video_size: number }
}

/** 工具调用条目 */
export interface ToolCallItem {
  type: 11 | 12
  tool_call_start_item?: { tool_name?: string }
  tool_call_result_item?: { tool_name?: string }
}

/** 消息条目 */
export type IlinkItem = TextItem | ImageItem | VoiceItem | FileItem | VideoItem | ToolCallItem

/** 局部引用元数据 */
export interface PartialText {
  start: string
  end: string
  startindex: number
  endindex: number
  quotemd5: string
}

/** 引用消息 */
export interface RefMessage {
  message_item?: ItemWithRef
  message_id?: string
  msg_id?: string
  /** 新版客户端仅携带的服务端消息ID 用于本地缓存还原引用 */
  svr_id?: string
  client_id?: string
  from_user_id?: string
  from_user_name?: string
  partial_text?: PartialText
}

/** 带引用的消息条目 */
export type ItemWithRef = Partial<IlinkItem> & { ref_msg?: RefMessage }

/** 接收到的消息 */
export interface IlinkMessage {
  from_user_id: string
  from_user_name?: string
  message_id?: string
  msg_id?: string
  client_id?: string
  context_token?: string
  item_list?: ItemWithRef[]
}

/** 二维码响应 */
export interface QRCodeResponse {
  /** 扫码内容串 */
  qrcode: string
  /** 二维码图片 base64 */
  qrcode_img_content: string
}

/** 二维码扫码状态 */
export interface QRCodeStatus {
  status: 'waiting' | 'confirmed' | 'expired'
  ilink_user_id?: string
  ilink_bot_id?: string
  bot_token?: string
  nickname?: string
  baseurl?: string
}

/** 发送消息响应 */
export interface SendMessageResponse {
  msg?: { message_id?: string }
  message_id?: string
}

/** 消息更新响应 */
export interface UpdatesResponse {
  ret?: number
  msgs?: IlinkMessage[]
  get_updates_buf?: string
  /** 服务端建议的下轮长轮询超时 (ms) */
  longpolling_timeout_ms?: number
}

/** 正在输入状态 */
export interface TypingState {
  ticket: string
  contextToken: string
  expire: number
  timer: NodeJS.Timeout
  autoStop: NodeJS.Timeout
  owners: Set<string>
}

/** API 客户端选项 */
export interface ClientOptions {
  /** 登录凭证 bot_token */
  token?: string
  /** 覆盖 API 地址 扫码登录成功时使用 */
  baseUrl?: string
  /** 覆盖 CDN 地址 */
  cdnUrl?: string
  /** API 超时 (ms) */
  apiTimeout?: number
  /** 长轮询超时 (ms) */
  longPollTimeout?: number
}

/** API 请求选项 */
export interface RequestOptions {
  params?: Record<string, string>
  body?: object
  token?: boolean
  timeout?: number
  headers?: Record<string, string>
}

/** 媒体上传凭证响应 */
export interface UploadUrlResponse {
  upload_param?: string
  upload_full_url?: string
}

/** 媒体上传结果 */
export interface UploadResult {
  media: IlinkMedia
  fileSize: number
  rawSize: number
  fileName: string
}

/** 媒体格式信息 */
export interface FormatInfo {
  mime: string
  ext: string
  kind: 'image' | 'video' | 'audio' | 'file'
}

/** 媒体格式识别结果 */
export interface Detected {
  format: string
  mime: string
  ext: string
  kind: 'image' | 'video' | 'audio' | 'file'
}

/** 媒体解析选项 */
export interface ResolveOptions {
  /** 下载超时 (ms) */
  timeoutMs?: number
  /** 大小上限 (bytes) */
  maxBytes?: number
  /** 指定文件名 */
  fileName?: string
}

/** 媒体解析结果 */
export interface Resolved extends Detected {
  buffer: Buffer
  fileName: string
}
