/**
 * 前端配置 API 封装
 * - 生产环境与 Karin WebUI 同源, 直接使用相对路径
 * - 开发环境(next dev)下可通过 URL query 或 localStorage 指定后端地址 `host`
 */

/** 后端 API 前缀 需与 src/server.ts 保持一致 */
export const API_PREFIX = '/adapter-all/api/config'

/** 单个 bot 连接配置 与后端 src/adapters/base.ts 的 BotConfig 对应 */
export interface BotConfig {
  enable?: boolean
  protocol?: 'onebot11' | 'onebot12' | 'icqq' | 'milky' | 'kook' | 'qqbot' | 'douyin' | 'wxoc'
  impl?: 'snowluma' | 'napcat' | 'lagrange' | 'std'
  /** onebot11 通信方式 默认 ws (正向 WebSocket) */
  communication?: 'http' | 'ws' | 'ws-reverse' | 'sse'
  url?: string
  /** HTTP 模式下的本端事件上报监听地址 */
  eventUrl?: string
  /** milky 事件接收方式 默认 ws */
  eventMode?: 'ws' | 'sse' | 'webhook'
  accessToken?: string
  reconnect?: boolean
  heartbeatInterval?: number
  requestTimeout?: number
  /* ==================== icqq 专属 (协议直连 不依赖 url) ==================== */
  uin?: number | string
  password?: string
  loginType?: 'fast' | 'password' | 'qrcode'
  platform?: number
  ver?: string
  sign_api_addr?: string
  /** icqq 滑动验证方式 默认 gt */
  sliderMode?: 'gt' | 'txhelper' | 'manual'
  /* ==================== kook 专属 (官方 API 直连 token 鉴权, 不依赖 url) ==================== */
  kookToken?: string
  /** kook 事件接收方式 默认 ws */
  kookEventMode?: 'ws' | 'webhook'
  /** kook webhook 模式本端监听地址 如 0.0.0.0:8091 */
  kookWebhookUrl?: string
  /* ==================== qqbot 专属 (开放平台 appid+appsecret 鉴权, 不依赖 url) ==================== */
  qqbotAppId?: string
  /** QQ开放平台 AppSecret 官方接入票据 通过 AccessToken 机制鉴权 */
  qqbotClientSecret?: string
  /** qqbot 事件接收方式 默认 ws */
  qqbotEventMode?: 'ws' | 'webhook'
  /** qqbot webhook 模式本端监听地址 如 0.0.0.0:8092 */
  qqbotWebhookUrl?: string
  /* ==================== douyin 专属 (扫码登录后回填, 凭据存后端 data/douyin-accounts) ==================== */
  /** 抖音账号数字 uid */
  douyinUid?: string
  /** 抖音账号昵称 (显示用) */
  douyinName?: string
  /* ==================== wxoc 专属 (微信 Claw ilink 协议, 扫码登录后回填) ==================== */
  /** 登录凭证 bot_token */
  wxocToken?: string
  /** ilink 机器人 ID */
  wxocAccountId?: string
  /** ilink 用户 ID */
  wxocUserId?: string
  /** 账号昵称 (显示用) */
  wxocNickname?: string
  /** 登录返回的 API 地址 (可选) */
  wxocBaseUrl?: string
  /* ==================== 通用 (kook/qqbot 消息正则替换) ==================== */
  /**
   * 消息正则替换总开关: 默认开启, 设为 false 时规则不生效
   */
  msgReplaceEnable?: boolean
  /**
   * 消息正则替换 (kook/qqbot): 收到消息后对文本段依次应用正则替换,
   * 如把 /命令 转为 Karin 默认前缀的 #命令
   */
  msgReplace?: Array<{ match: string; to: string }>
}

/** 配置文件整体结构 */
export interface PluginConfig {
  bots?: BotConfig[]
}

/** 渲染用的 bot 表单数据 数字字段以字符串承载方便输入 */
export interface BotForm {
  enable: boolean
  protocol: string
  impl: string
  communication: string
  url: string
  eventUrl: string
  eventMode: string
  accessToken: string
  reconnect: boolean
  heartbeatInterval: string
  requestTimeout: string
  /* icqq 专属 */
  uin: string
  password: string
  loginType: string
  platform: string
  ver: string
  signApiAddr: string
  sliderMode: string
  /* kook 专属 */
  kookToken: string
  kookEventMode: string
  kookWebhookUrl: string
  /* qqbot 专属 */
  qqbotAppId: string
  qqbotClientSecret: string
  qqbotEventMode: string
  qqbotWebhookUrl: string
  /* douyin 专属 */
  douyinUid: string
  douyinName: string
  /* wxoc 专属 */
  wxocToken: string
  wxocAccountId: string
  wxocUserId: string
  wxocNickname: string
  wxocBaseUrl: string
  /* kook/qqbot/douyin/wxoc 消息正则替换 (文本域, 每行一条: 正则 替换) */
  msgReplaceEnable: boolean
  msgReplace: string
}

export const PROTOCOLS = ['onebot11', 'onebot12', 'icqq', 'milky', 'kook', 'qqbot', 'douyin', 'wxoc'] as const
export const IMPLS = ['snowluma', 'napcat', 'lagrange', 'std'] as const
export const COMMUNICATIONS = ['ws', 'ws-reverse', 'http', 'sse'] as const
/** milky 事件接收方式 */
export const EVENT_MODES = ['ws', 'sse', 'webhook'] as const

export const getApiBase = () => API_PREFIX

/* ==================== WebUI 鉴权 (与 Karin WebUI 同一 token) ==================== */

const AUTH_STORAGE = 'adapter-all-auth'
/** 登录失效事件: 401 时广播, 页面据此回到登录页 */
export const UNAUTHORIZED_EVENT = 'adapter-all:unauthorized'

export const getStoredAuth = (): string => {
  if (typeof window === 'undefined') return ''
  // 优先本页登录凭证; 其次复用同源 Karin WebUI 的 accessToken (WebUI iframe 内打开时自动登录)
  const own = localStorage.getItem(AUTH_STORAGE)
  if (own) return own
  if (karinTokenRejected) return ''
  return localStorage.getItem('accessToken') ?? ''
}

/** Karin WebUI 的 JWT 被后端拒绝 (过期/失效) 后本次会话不再复用, 引导手动登录 */
let karinTokenRejected = false
export const rejectKarinToken = () => { karinTokenRejected = true }
export const setStoredAuth = (token: string) => localStorage.setItem(AUTH_STORAGE, token)
export const clearStoredAuth = () => localStorage.removeItem(AUTH_STORAGE)

/** 鉴权请求头: Bearer token (Karin 支持明文秘钥校验) */
export const authHeaders = (): Record<string, string> => {
  const token = getStoredAuth()
  return token ? { Authorization: `Bearer ${token}` } : {}
}

/** 401 统一处理: 清除本地凭证并广播事件 */
const onUnauthorized = () => {
  clearStoredAuth()
  rejectKarinToken()
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(UNAUTHORIZED_EVENT))
}

/** 合并基础头与鉴权头 */
const withAuth = (headers: Record<string, string> = {}): Record<string, string> => ({
  Accept: 'application/json',
  ...headers,
  ...authHeaders(),
})

/** WebUI 登录: 校验 token (即 Karin 的 HTTP_AUTH_KEY) */
export const loginApi = async (token: string): Promise<{ success: boolean; message: string }> => {
  const res = await fetch(`${getApiBase()}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${token.trim()}` },
    body: JSON.stringify({ authorization: `Bearer ${token.trim()}` }),
  })
  const json = await res.json().catch(() => ({}))
  const message = json?.message ?? (res.ok ? '登录成功' : 'token 错误')
  return { success: res.ok && json?.code !== 500, message }
}

/** 加载当前配置 */
export const fetchConfig = async (): Promise<PluginConfig> => {
  const res = await fetch(getApiBase(), { headers: withAuth() })
  if (res.status === 401) { onUnauthorized(); throw new Error('未登录或登录已失效') }
  if (!res.ok) throw new Error(`加载配置失败: HTTP ${res.status}`)
  const json = await res.json()
  return (json?.data ?? {}) as PluginConfig
}

/** 保存配置 */
export const saveConfigApi = async (config: PluginConfig): Promise<{ success: boolean; message: string }> => {
  const res = await fetch(getApiBase(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(config),
  })
  if (res.status === 401) { onUnauthorized(); return { success: false, message: '未登录或登录已失效' } }
  const json = await res.json().catch(() => ({}))
  const message = json?.message ?? (res.ok ? '保存成功' : `HTTP ${res.status}`)
  return { success: res.ok && json?.code !== 500, message }
}

/** 探测 @icqqjs/icqq 是否已安装 (ICQQ 卡片展示安装引导) */
export const fetchIcqqStatus = async (): Promise<boolean> => {
  const res = await fetch(`${getApiBase()}/icqq/status`, { headers: withAuth() })
  if (res.status === 401) { onUnauthorized(); return false }
  const json = await res.json().catch(() => null)
  return Boolean(json?.data?.available)
}

/** 代理获取签名服务 /ver 可用版本列表 (后端转发, 避开浏览器 CORS) */
export const fetchSignVersions = async (addr: string, uin?: string): Promise<{ ver: string[] }> => {
  const params = new URLSearchParams({ addr: addr.trim() })
  if (uin?.trim()) params.set('uin', uin.trim())
  const res = await fetch(`${getApiBase()}/sign/ver?${params}`, { headers: withAuth() })
  if (res.status === 401) { onUnauthorized(); throw new Error('未登录或登录已失效') }
  const json = await res.json().catch(() => null)
  if (!res.ok) {
    // 后端代理失败时透出具体原因 (如连接被拒/超时/非 JSON 响应)
    const msg = json?.message || json?.error || (`HTTP ${res.status}`)
    throw new Error(`获取版本失败: ${msg}`)
  }
  // 后端成功约定为 code=200 (node-karin createSuccessResponse), 兼容 code=0
  const ok = json?.code === 0 || json?.code === 200
  if (!ok || !json?.data) throw new Error(json?.message || '签名服务返回异常')
  const ver = (json.data.ver ?? []) as string[]
  if (!ver.length) throw new Error('签名服务未返回可用的 ver 列表')
  return { ver }
}

/** 消息正则替换默认规则 (新建连接时预填): /命令 转为 Karin 默认前缀 #命令 */
export const DEFAULT_MSG_REPLACE = '^\\s*/ #'

/** 通用扫码/登录接口响应 */
export interface ApiResult<T> {
  success: boolean
  data?: T
  message?: string
}

/** 登录接口统一调用: POST JSON → 解析 code/data/message (前缀与 server.ts 挂载点 /api/douyin/login、/api/wxoc/qr 对应) */
const postApi = async <T> (path: string, body?: Record<string, unknown>): Promise<ApiResult<T>> => {
  const res = await fetch(`/adapter-all/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify(body ?? {}),
  })
  if (res.status === 401) { onUnauthorized(); return { success: false, message: '未登录或登录已失效' } }
  const json = await res.json().catch(() => null) as { data?: T; message?: string; code?: number } | null
  if (!json) return { success: false, message: `接口响应异常 (HTTP ${res.status})` }
  return { success: res.ok && json.code !== 500, data: json.data, message: json.message || (res.ok ? '' : `接口异常 (HTTP ${res.status})`) }
}

/* ==================== 抖音扫码登录 ==================== */

/** 抖音登录状态快照 */
export interface DouyinLoginSnapshot {
  phase: 'pending' | 'scanned' | 'verifying' | 'mfa' | 'success' | 'expired' | 'error'
  /** 二维码图片 (dataURL, pending 阶段) */
  image?: string
  statusText?: string
  mfaKind?: 'sms' | 'password'
  maskedMobile?: string
  /** 安全验证中心页地址 (verifying 阶段, 面板内 iframe 展示) */
  verifyUrl?: string
  uid?: string
  name?: string
  error?: string
}

export const douyinLoginStart = () => postApi<{ id: string }>('/douyin/login/start')
export const douyinLoginStatus = (sid: string) => postApi<DouyinLoginSnapshot>('/douyin/login/status', { sid })
export const douyinLoginMfa = (sid: string, code: string) => postApi<null>('/douyin/login/mfa', { sid, code })
export const douyinLoginCancel = (sid: string) => postApi<null>('/douyin/login/cancel', { sid })

/* ==================== 微信 Claw (wxoc) 扫码登录 ==================== */

/** wxoc 扫码状态 */
export interface WxocQrSnapshot {
  phase: 'pending' | 'scanned' | 'expired'
  token?: string
  accountId?: string
  userId?: string
  nickname?: string
  baseUrl?: string
}

export const wxocQrStart = () => postApi<{ id: string; image: string }>('/wxoc/qr/start')
export const wxocQrStatus = (sid: string) => postApi<WxocQrSnapshot>('/wxoc/qr/status', { sid })
export const wxocQrCancel = (sid: string) => postApi<null>('/wxoc/qr/cancel', { sid })

/** 将后端配置转为表单数据 */
export const toForm = (bot?: BotConfig): BotForm => ({
  enable: bot?.enable !== false,
  protocol: bot?.protocol ?? 'onebot11',
  impl: bot?.impl ?? 'snowluma',
  communication: bot?.communication ?? 'ws',
  url: bot?.url ?? '',
  eventUrl: bot?.eventUrl ?? '',
  eventMode: bot?.eventMode ?? 'ws',
  accessToken: bot?.accessToken ?? '',
  reconnect: bot?.reconnect !== false,
  heartbeatInterval: bot?.heartbeatInterval ? String(bot.heartbeatInterval) : '',
  requestTimeout: bot?.requestTimeout ? String(bot.requestTimeout) : '',
  uin: bot?.uin !== undefined ? String(bot.uin) : '',
  password: bot?.password ?? '',
  loginType: bot?.loginType ?? 'fast',
  platform: bot?.platform !== undefined ? String(bot.platform) : '',
  ver: bot?.ver ?? '',
  signApiAddr: bot?.sign_api_addr ?? '',
  sliderMode: bot?.sliderMode ?? 'gt',
  kookToken: bot?.kookToken ?? '',
  kookEventMode: bot?.kookEventMode ?? 'ws',
  kookWebhookUrl: bot?.kookWebhookUrl ?? '',
  qqbotAppId: bot?.qqbotAppId ?? '',
  qqbotClientSecret: bot?.qqbotClientSecret ?? '',
  qqbotEventMode: bot?.qqbotEventMode ?? 'ws',
  qqbotWebhookUrl: bot?.qqbotWebhookUrl ?? '',
  douyinUid: bot?.douyinUid ?? '',
  douyinName: bot?.douyinName ?? '',
  wxocToken: bot?.wxocToken ?? '',
  wxocAccountId: bot?.wxocAccountId ?? '',
  wxocUserId: bot?.wxocUserId ?? '',
  wxocNickname: bot?.wxocNickname ?? '',
  wxocBaseUrl: bot?.wxocBaseUrl ?? '',
  msgReplaceEnable: bot?.msgReplaceEnable !== false,
  // 新建连接 (无 bot) 时预填默认替换规则; 已有配置保持原值 (可为空)
  msgReplace: bot
    ? (bot.msgReplace ?? []).map((r) => `${r.match} ${r.to}`).join('\n')
    : DEFAULT_MSG_REPLACE,
})

/** 解析文本域中的消息替换规则 (每行一条「正则 替换」, 首处空白分隔; 无空白则替换为空即删除匹配) */
const parseMsgReplace = (raw: string): BotConfig['msgReplace'] => {
  const rules: BotConfig['msgReplace'] = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    const sp = s.search(/\s/)
    rules.push(sp === -1 ? { match: s, to: '' } : { match: s.slice(0, sp).trim(), to: s.slice(sp).trim() })
  }
  return rules.length ? rules : undefined
}

/** 将表单数据转为后端配置 过滤空地址/非法协议 */
export const fromForm = (form: BotForm): BotConfig | undefined => {
  if (!(PROTOCOLS as readonly string[]).includes(form.protocol)) return undefined
  const url = form.url.trim()
  const isIcqq = form.protocol === 'icqq'
  // icqq / kook / qqbot / douyin / wxoc 为协议直连(token 或 appid 鉴权) 不要求 url; 其余协议须有连接地址
  if (!isIcqq && form.protocol !== 'kook' && form.protocol !== 'qqbot' && form.protocol !== 'douyin' && form.protocol !== 'wxoc' && !url) return undefined
  const bot: BotConfig = { enable: form.enable, protocol: form.protocol as BotConfig['protocol'], url }
  if (isIcqq) {
    const uin = Number(form.uin.trim())
    if (form.uin.trim() && Number.isFinite(uin)) bot.uin = uin
    if (form.password) bot.password = form.password
    if (form.loginType === 'password' || form.loginType === 'qrcode' || form.loginType === 'fast') {
      bot.loginType = form.loginType
    }
    const platform = Number(form.platform.trim())
    if (form.platform.trim() && Number.isFinite(platform)) bot.platform = platform
    if (form.ver.trim()) bot.ver = form.ver.trim()
    if (form.signApiAddr.trim()) bot.sign_api_addr = form.signApiAddr.trim()
    if (form.sliderMode === 'gt' || form.sliderMode === 'txhelper' || form.sliderMode === 'manual') {
      bot.sliderMode = form.sliderMode
    }
    if (bot.uin === undefined && !bot.password && bot.loginType !== 'qrcode') return undefined
    delete bot.url
    return bot
  }
  if (form.protocol === 'onebot11' && (IMPLS as readonly string[]).includes(form.impl)) bot.impl = form.impl as BotConfig['impl']
  if (form.protocol === 'onebot11') {
    if ((COMMUNICATIONS as readonly string[]).includes(form.communication)) {
      const communication = form.communication as BotConfig['communication']
      if (communication !== 'ws') bot.communication = communication
    }
    if ((bot.communication ?? 'ws') === 'http' || (bot.communication ?? 'ws') === 'sse') {
      const eventUrl = form.eventUrl.trim()
      if (eventUrl) bot.eventUrl = eventUrl
    }
  }
  if (form.protocol === 'milky') {
    // 事件接收方式 默认 ws; webhook 额外需要本端监听地址 eventUrl
    if (form.eventMode === 'sse' || form.eventMode === 'webhook') bot.eventMode = form.eventMode
    if (form.eventMode === 'webhook') {
      const eventUrl = form.eventUrl.trim()
      if (eventUrl) bot.eventUrl = eventUrl
    }
  }
  if (form.protocol === 'kook') {
    // kook 专属: token 必填; webhook 模式额外需要本端监听地址
    if (!form.kookToken.trim()) return undefined
    bot.kookToken = form.kookToken.trim()
    if (form.kookEventMode === 'webhook') {
      if (!form.kookWebhookUrl.trim()) return undefined
      bot.kookEventMode = 'webhook'
      bot.kookWebhookUrl = form.kookWebhookUrl.trim()
    }
    const mr = parseMsgReplace(form.msgReplace)
    if (mr) bot.msgReplace = mr
    if (form.msgReplaceEnable === false) bot.msgReplaceEnable = false
    delete bot.url
    return bot
  }
  if (form.protocol === 'qqbot') {
    // qqbot 专属: appid + appsecret 必填 (官方新鉴权 AccessToken 机制); webhook 模式额外需要本端监听地址
    const appId = form.qqbotAppId.trim()
    const clientSecret = form.qqbotClientSecret.trim()
    if (!appId || !clientSecret) return undefined
    bot.qqbotAppId = appId
    bot.qqbotClientSecret = clientSecret
    if (form.qqbotEventMode === 'webhook') {
      if (!form.qqbotWebhookUrl.trim()) return undefined
      bot.qqbotEventMode = 'webhook'
      bot.qqbotWebhookUrl = form.qqbotWebhookUrl.trim()
    }
    const mr = parseMsgReplace(form.msgReplace)
    if (mr) bot.msgReplace = mr
    if (form.msgReplaceEnable === false) bot.msgReplaceEnable = false
    delete bot.url
    return bot
  }
  if (form.protocol === 'douyin') {
    // douyin 专属: 扫码登录后回填 uid (凭据由后端落盘, 配置仅存 uid/昵称)
    const uid = form.douyinUid.trim()
    if (!uid) return undefined
    bot.douyinUid = uid
    if (form.douyinName.trim()) bot.douyinName = form.douyinName.trim()
    const mr = parseMsgReplace(form.msgReplace)
    if (mr) bot.msgReplace = mr
    if (form.msgReplaceEnable === false) bot.msgReplaceEnable = false
    delete bot.url
    return bot
  }
  if (form.protocol === 'wxoc') {
    // wxoc 专属: 扫码登录后回填 token + accountId
    const token = form.wxocToken.trim()
    const accountId = form.wxocAccountId.trim()
    if (!token || !accountId) return undefined
    bot.wxocToken = token
    bot.wxocAccountId = accountId
    if (form.wxocUserId.trim()) bot.wxocUserId = form.wxocUserId.trim()
    if (form.wxocNickname.trim()) bot.wxocNickname = form.wxocNickname.trim()
    if (form.wxocBaseUrl.trim()) bot.wxocBaseUrl = form.wxocBaseUrl.trim()
    const mr = parseMsgReplace(form.msgReplace)
    if (mr) bot.msgReplace = mr
    if (form.msgReplaceEnable === false) bot.msgReplaceEnable = false
    delete bot.url
    return bot
  }
  if (form.accessToken.trim()) bot.accessToken = form.accessToken.trim()
  if (form.reconnect !== true) bot.reconnect = false
  const hb = Number(form.heartbeatInterval)
  const rt = Number(form.requestTimeout)
  if (Number.isFinite(hb) && hb > 0) bot.heartbeatInterval = hb
  if (Number.isFinite(rt) && rt > 0) bot.requestTimeout = rt
  return bot
}