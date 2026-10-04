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
  protocol?: 'onebot11' | 'onebot12' | 'icqq' | 'milky' | 'kook' | 'qqbot'
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
  /** icqq 滑动验证方式 默认 auto (全通道并行, 任一成功即继续) */
  sliderMode?: 'auto' | 'gt' | 'txhelper' | 'pages' | 'manual'
  /** 自建 Cloudflare Pages 验证码处理页地址 (sliderMode=pages 时必填) */
  captchaBase?: string
  /** 验证码服务注册 Token (与 Pages 端 CAPTCHA_TOKEN 一致, 可选) */
  captchaToken?: string
  /* ==================== kook 专属 (官方 API 直连 token 鉴权, 不依赖 url) ==================== */
  kookToken?: string
  kookApi?: string
  /** kook 事件接收方式 默认 ws */
  kookEventMode?: 'ws' | 'webhook'
  /** kook webhook 模式本端监听地址 如 0.0.0.0:8091 */
  kookWebhookUrl?: string
  /* ==================== qqbot 专属 (开放平台 appid+appsecret 鉴权, 不依赖 url) ==================== */
  qqbotAppId?: string
  /** QQ开放平台 AppSecret 官方接入票据 通过 AccessToken 机制鉴权 */
  qqbotClientSecret?: string
  qqbotApi?: string
  /** qqbot 事件接收方式 默认 ws */
  qqbotEventMode?: 'ws' | 'webhook'
  /** qqbot webhook 模式本端监听地址 如 0.0.0.0:8092 */
  qqbotWebhookUrl?: string
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
  captchaBase: string
  captchaToken: string
  /* kook 专属 */
  kookToken: string
  kookApi: string
  kookEventMode: string
  kookWebhookUrl: string
  /* qqbot 专属 */
  qqbotAppId: string
  qqbotClientSecret: string
  qqbotApi: string
  qqbotEventMode: string
  qqbotWebhookUrl: string
  /* kook/qqbot 消息正则替换 (文本域, 每行一条: 正则 替换) */
  msgReplaceEnable: boolean
  msgReplace: string
}

export const PROTOCOLS = ['onebot11', 'onebot12', 'icqq', 'milky', 'kook', 'qqbot'] as const
export const IMPLS = ['snowluma', 'napcat', 'lagrange', 'std'] as const
export const COMMUNICATIONS = ['ws', 'ws-reverse', 'http', 'sse'] as const
/** milky 事件接收方式 */
export const EVENT_MODES = ['ws', 'sse', 'webhook'] as const

/** 解析后端地址: query > localStorage > 同源 (login-events SSE 复用) */
export const resolveHost = (): string => {
  if (typeof window === 'undefined') return ''
  const fromQuery = new URLSearchParams(window.location.search).get('host')
  if (fromQuery) return fromQuery.replace(/\/+$/, '')
  const saved = localStorage.getItem('adapter-all-host')
  if (saved) return saved.replace(/\/+$/, '')
  return ''
}

/** 保存用户覆盖的后端地址 用于 next dev 联调 */
export const saveHostOverride = (host: string) => {
  localStorage.setItem('adapter-all-host', host.replace(/\/+$/, ''))
}

export const getApiBase = () => `${resolveHost()}${API_PREFIX}`

/** 加载当前配置 */
export const fetchConfig = async (): Promise<PluginConfig> => {
  const res = await fetch(getApiBase(), { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`加载配置失败: HTTP ${res.status}`)
  const json = await res.json()
  return (json?.data ?? {}) as PluginConfig
}

/** 保存配置 */
export const saveConfigApi = async (config: PluginConfig): Promise<{ success: boolean; message: string }> => {
  const res = await fetch(getApiBase(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  })
  const json = await res.json().catch(() => ({}))
  const message = json?.message ?? (res.ok ? '保存成功' : `HTTP ${res.status}`)
  return { success: res.ok && json?.code !== 500, message }
}

/** 代理获取签名服务 /ver 可用版本列表 (后端转发, 避开浏览器 CORS) */
export const fetchSignVersions = async (addr: string, uin?: string): Promise<{ ver: string[] }> => {
  const params = new URLSearchParams({ addr: addr.trim() })
  if (uin?.trim()) params.set('uin', uin.trim())
  const res = await fetch(`${getApiBase()}/sign/ver?${params}`, { headers: { Accept: 'application/json' } })
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
  sliderMode: bot?.sliderMode ?? 'auto',
  captchaBase: bot?.captchaBase ?? '',
  captchaToken: bot?.captchaToken ?? '',
  kookToken: bot?.kookToken ?? '',
  kookApi: bot?.kookApi ?? '',
  kookEventMode: bot?.kookEventMode ?? 'ws',
  kookWebhookUrl: bot?.kookWebhookUrl ?? '',
  qqbotAppId: bot?.qqbotAppId ?? '',
  qqbotClientSecret: bot?.qqbotClientSecret ?? '',
  qqbotApi: bot?.qqbotApi ?? '',
  qqbotEventMode: bot?.qqbotEventMode ?? 'ws',
  qqbotWebhookUrl: bot?.qqbotWebhookUrl ?? '',
  msgReplaceEnable: bot?.msgReplaceEnable !== false,
  msgReplace: (bot?.msgReplace ?? []).map((r) => `${r.match} ${r.to}`).join('\n'),
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
  // icqq / kook / qqbot 为协议直连(token 或 appid 鉴权) 不要求 url; 其余协议须有连接地址
  if (!isIcqq && form.protocol !== 'kook' && form.protocol !== 'qqbot' && !url) return undefined
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
    if (form.sliderMode === 'gt' || form.sliderMode === 'txhelper' || form.sliderMode === 'pages' || form.sliderMode === 'manual') {
      bot.sliderMode = form.sliderMode
    }
    if (form.captchaBase.trim()) bot.captchaBase = form.captchaBase.trim()
    if (form.captchaToken.trim()) bot.captchaToken = form.captchaToken.trim()
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
    if (form.kookApi.trim()) bot.kookApi = form.kookApi.trim()
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
    if (form.qqbotApi.trim()) bot.qqbotApi = form.qqbotApi.trim()
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
  if (form.accessToken.trim()) bot.accessToken = form.accessToken.trim()
  if (form.reconnect !== true) bot.reconnect = false
  const hb = Number(form.heartbeatInterval)
  const rt = Number(form.requestTimeout)
  if (Number.isFinite(hb) && hb > 0) bot.heartbeatInterval = hb
  if (Number.isFinite(rt) && rt > 0) bot.requestTimeout = rt
  return bot
}