import { createServer, type Server } from 'node:http'
import { logger } from 'node-karin'
import WebSocket from 'ws'
import type { BotConfig } from '../base'

/** QQBot 事件接收方式 */
export type QqBotEventMode = 'ws' | 'webhook'

/** 事件通道回调 (由 QqBotBot 绑定) */
export interface QqBotEventHandlers {
  /** 连接建立 / 服务启动 */
  onOpen: () => void
  /** 收到一条 QQBot 事件 (已规范化 { type: 事件类型, data: 事件体 }) */
  onMessage: (event: { type: string; data: any }) => void
  /** 错误(带 message) */
  onError: (err: Error) => void
  /** 连接断开 (WebHook 模式恒不触发) */
  onClose: () => void
}

/**
 * QQBot 事件接收通道:
 *  - ws      官方 WebSocket Gateway: 拉取地址 → 连接 → Hello(10) → Identify(2) → 定时心跳(1)
 *  - webhook 本端 HTTP 服务接收开放平台回调 POST (路径 /webhook/qqbot)
 */
export interface QqBotEventChannel {
  readonly mode: QqBotEventMode
  /** 当前是否已连接 / 服务是否已监听 */
  readonly isConnected: boolean
  /** 对外展示的事件地址 */
  readonly address: string
  /** 启动事件接收 (断线按 cfg.reconnect 自动重连) */
  start (handlers: QqBotEventHandlers): void
  /** 停止接收并断开 (不再重连) */
  stop (): void
}

/** QQBot 需要的 intents: 频道消息(私域+公域) + 频道私信 + 群聊/C2C(含机器人进出群/权限开关) + 群成员事件(成员增减/加群申请) + 按钮回调(INTERACTION) */
const QQ_INTENTS = (1 << 9) | (1 << 12) | (1 << 24) | (1 << 25) | (1 << 26) | (1 << 30)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 规范化 webhook/ws 事件均输出 { type, data } */
const normalize = (raw: any): { type: any; data: any } => {
  if (raw && typeof raw === 'object') {
    // 多条事件数组
    if (Array.isArray(raw)) {
      const first = raw[0] || {}
      return { type: first.t || first.type, data: first.d }
    }
    // 事件字段可能在 t / type / op 下, d 为数据
    return { type: raw.t || raw.type, data: raw.d }
  }
  return { type: '', data: raw }
}

/* ==================== WebSocket (官方 Gateway) ==================== */

class QqBotWsChannel implements QqBotEventChannel {
  readonly mode = 'ws' as const
  readonly address: string
  private ws?: WebSocket
  private stopped = false
  private busy = false
  private reconnectTimer?: NodeJS.Timeout
  private heartbeatTimer?: NodeJS.Timeout
  /** 心跳间隔 (Hello 下发, ms) */
  private heartbeatInterval = 41250
  /** 已鉴权 (收到 Hello 后等待 identify; 重连需重新) */
  private identified = false

  constructor (cfg: BotConfig, authToken?: () => Promise<string>) {
    this.address = `QQBot Gateway (appid:${cfg.qqbotAppId || ''})`
    this.cfg = cfg
    this.authToken = authToken
  }

  private readonly cfg: BotConfig
  /** Gateway 鉴权凭证提供者: 返回官方 AccessToken, Identify 时拼 `QQBot {token}` */
  private readonly authToken?: () => Promise<string>

  get isConnected () {
    return this.ws?.readyState === WebSocket.OPEN
  }

  start (handlers: QqBotEventHandlers) {
    this.stopped = false
    this.#connect(handlers)
  }

  /** 拉取 Gateway 地址并连接 */
  async #connect (handlers: QqBotEventHandlers, gatewayUrl?: string) {
    if (this.busy) return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.busy = true
    let url = gatewayUrl
    if (!url) {
      // 兜底: 官方默认网关 (新鉴权统一地址 api.bot.qq.com)
      url = 'wss://api.bot.qq.com/websocket/'
    }
    const ws = new WebSocket(url)
    this.ws = ws
    this.identified = false
    ws.on('open', () => {
      this.busy = false
      handlers.onOpen()
    })
    ws.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      let raw = ''
      if (Array.isArray(data)) {
        raw = Buffer.concat(data).toString()
      } else if (data instanceof ArrayBuffer) {
        raw = Buffer.from(data).toString()
      } else {
        raw = data.toString()
      }
      let body: any
      try {
        body = JSON.parse(raw)
      } catch {
        return
      }
      this.#handleOp(body, handlers)
    })
    ws.on('error', (err) => handlers.onError(err))
    ws.on('close', (code, reason) => {
      this.busy = false
      this.ws = undefined
      this.#stopHeartbeat()
      handlers.onClose()
      if (this.stopped) return
      if (code === 4004 || /token|auth|401/i.test(reason?.toString() || '')) {
        logger.warn('[QQBot] 鉴权失败: 请检查 qqbotAppId / qqbotClientSecret 是否正确')
        return
      }
      if (this.cfg.reconnect !== false) {
        logger.warn(`[QQBot] Gateway 连接断开 (code=${code}), 5s 后重连`)
        this.reconnectTimer = setTimeout(() => {
          this.#connect(handlers)
        }, 5000)
      }
    })
  }

  /** 心跳 */
  #startHeartbeat () {
    this.#stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.send(JSON.stringify({ op: 1 })) } catch { /* 静默 */ }
      }
    }, this.heartbeatInterval)
  }

  #stopHeartbeat () {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
  }

  /** 发送 Identify (op 2) 登录鉴权: token 为 "QQBot {AccessToken}" */
  async #identify () {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return
    if (!this.authToken) {
      logger.warn('[QQBot] 缺少 Gateway 鉴权凭证提供者, 无法完成登录鉴权')
      return
    }
    const token = await this.authToken()
    try { this.ws.send(JSON.stringify({ op: 2, d: { token: `QQBot ${token}`, intents: QQ_INTENTS } })) } catch { /* 静默 */ }
  }

  /** 处理 gateway 报文 op */
  async #handleOp (body: any, handlers: QqBotEventHandlers) {
    const op = Number(body.op)
    switch (op) {
      case 10: {
        // Hello: 下发心跳间隔, 发送 Identify
        this.heartbeatInterval = Number(body.d?.heartbeat_interval) || 41250
        await this.#identify()
        this.identified = true
        this.#startHeartbeat()
        break
      }
      case 11:
        // Heartbeat ACK
        break
      case 7:
        // Reconnect
        logger.warn('[QQBot] 服务端要求重连')
        this.ws?.close()
        break
      case 9:
        // Invalid Session: 重新 identify
        logger.warn('[QQBot] Invalid Session, 重新鉴权')
        await this.#identify()
        break
      case 0: {
        // Dispatch: 事件
        if (body.t) handlers.onMessage({ type: String(body.t), data: body.d })
        break
      }
      default:
        break
    }
  }

  stop () {
    this.stopped = true
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    this.#stopHeartbeat()
    const ws = this.ws
    this.ws = undefined
    if (ws) {
      ws.removeAllListeners()
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
    }
  }
}

/* ==================== WebHook ==================== */

class QqBotWebHookChannel implements QqBotEventChannel {
  readonly mode = 'webhook' as const
  readonly address: string
  private server?: Server
  private stopped = false

  constructor (private readonly cfg: BotConfig) {
    const { host, port } = this.#parseListen()
    this.address = `http://${host}:${port}/webhook/qqbot`
  }

  get isConnected () {
    return this.server !== undefined
  }

  /** 解析本端 WebHook 监听地址, 形如 0.0.0.0:8092 */
  #parseListen (): { host: string; port: number } {
    const raw = (this.cfg.qqbotWebhookUrl || '').trim()
    const m = /^(.+):(\d{1,5})$/.exec(raw)
    if (!m) {
      throw new Error('QQBot WebHook 模式需要本端监听地址 qqbotWebhookUrl, 形如 0.0.0.0:8092 (开放平台回调填 http://公网IP:8092/webhook/qqbot)')
    }
    return { host: m[1], port: Number(m[2]) }
  }

  start (handlers: QqBotEventHandlers) {
    this.stopped = false
    if (this.server) return
    const { host, port } = this.#parseListen()
    const path = '/webhook/qqbot'
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || (req.url || '').split('?')[0] !== path) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end('{}')
        return
      }
      let body = ''
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString()
        if (body.length > 10 * 1024 * 1024) req.destroy()
      })
      req.on('end', () => {
        try {
          const parsed = JSON.parse(body)
          // 开放平台回调可能为数组(多条事件)或单条 {t, d}
          const { type, data } = normalize(parsed)
          if (type) handlers.onMessage({ type: String(type), data })
          else {
            for (const raw of Array.isArray(parsed) ? parsed : [parsed]) {
              const n = normalize(raw)
              if (n.type) handlers.onMessage({ type: String(n.type), data: n.data })
            }
          }
        } catch {
          // 非 JSON 数据忽略
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      })
    })
    server.on('error', (err: Error) => handlers.onError(err))
    server.listen(port, host, () => {
      this.server = server
      handlers.onOpen()
      logger.info(`[QQBot] WebHook 服务已监听: ${this.address} (开放平台「事件订阅-回调地址」填写此地址)`)
    })
  }

  stop () {
    this.stopped = true
    const server = this.server
    this.server = undefined
    if (server) {
      server.removeAllListeners()
      server.close()
    }
  }
}

/* ==================== 工厂 ==================== */

/** 依据 cfg.qqbotEventMode 创建事件接收通道 (默认 ws) authToken 为 Gateway 鉴权凭证提供者 */
export const createQqBotEventChannel = (cfg: BotConfig, authToken?: () => Promise<string>): QqBotEventChannel => {
  const mode: QqBotEventMode = cfg.qqbotEventMode ?? 'ws'
  if (mode === 'webhook') return new QqBotWebHookChannel(cfg)
  return new QqBotWsChannel(cfg, authToken)
}