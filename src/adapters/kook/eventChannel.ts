import { createServer, type Server } from 'node:http'
import { logger } from 'node-karin'
import WebSocket from 'ws'
import type { BotConfig } from '../base'

/** Kook 事件接收方式 */
export type KookEventMode = 'ws' | 'webhook'

/** 事件通道回调 (由 KookBot 绑定) */
export interface KookEventHandlers {
  /** 连接建立 / 服务启动 */
  onOpen: () => void
  /** 收到一条 Kook 事件 (已 JSON.parse, 即 gateway 报文的 d 字段) */
  onMessage: (event: any) => void
  /** 错误(带 message) */
  onError: (err: Error) => void
  /** 连接断开 (WebHook 模式恒不触发) */
  onClose: () => void
  /** 断线重连时获取新的 Gateway 地址 (返回空则沿用旧地址) */
  onReconnect?: () => Promise<string | undefined>
}

/**
 * Kook 事件接收通道:
 *  - ws      官方 Gateway WebSocket (url 由 /gateway/index 获取, compress=0 文本帧, 心跳+重连)
 *  - webhook 本端 HTTP 服务接收 Kook 开发者后台回调 POST (路径 /webhook/kook)
 */
export interface KookEventChannel {
  readonly mode: KookEventMode
  /** 当前是否已连接 / 服务是否已监听 */
  readonly isConnected: boolean
  /** 对外展示的事件地址 */
  readonly address: string
  /** 启动事件接收 (ws 需先取到 gatewayUrl 再调用; 断线按 cfg.reconnect 自动重连) */
  start (handlers: KookEventHandlers, gatewayUrl?: string): void
  /** 停止接收并断开 (不再重连) */
  stop (): void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/* ==================== WebSocket (官方 Gateway) ==================== */

/**
 * Kook 官方 Gateway 信令 (developer.kookapp.cn/doc/websocket):
 *  s=0 事件(server->client, 带 sn 序号)
 *  s=1 握手 HELLO(server->client, d.session_id)
 *  s=2 心跳 PING(client->server, {s:2, sn: 已处理最大sn})
 *  s=3 心跳 PONG(server->client)
 *  s=4 RESUME(client->server) / s=5 RECONNECT(server->client) / s=6 RESUME ACK(server->client)
 * 心跳: 客户端每 30s(+/-5s) 主动发 PING, 6s 内未收到 PONG 判定失联。
 * 断线重连: 优先 resume(带 sn+session_id), 失败则重新获取 gateway 全新连接。
 */
class KookWsChannel implements KookEventChannel {
  readonly mode = 'ws' as const
  readonly address: string
  private ws?: WebSocket
  private stopped = false
  private busy = false
  private reconnectTimer?: NodeJS.Timeout
  private heartbeatTimer?: NodeJS.Timeout
  private pingTimer?: NodeJS.Timeout
  private handlers?: KookEventHandlers
  private gatewayUrl = ''
  /** 已处理的最大事件序号 (心跳/断线续传时回传) */
  private sn = 0
  /** 握手成功后服务端下发的会话 ID (断线 resume 用) */
  private sessionId = ''
  /** resume 已失败: 下次重连直接全新连接 */
  private resumeFailed = false

  constructor (private readonly cfg: BotConfig) {
    this.address = `Kook Gateway (token:${cfg.kookToken || ''})`
  }

  get isConnected () {
    return this.ws?.readyState === WebSocket.OPEN
  }

  start (handlers: KookEventHandlers, gatewayUrl?: string) {
    this.stopped = false
    this.handlers = handlers
    if (!gatewayUrl) {
      handlers.onError(new Error('Kook Gateway 地址为空'))
      return
    }
    this.gatewayUrl = gatewayUrl
    this.#connect(false)
  }

  /** 拼接 resume 参数 (仅在具备 resume 条件时) */
  #resumeUrl (resume: boolean): string {
    let url = this.gatewayUrl
    if (!resume || !this.sessionId) return url
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}resume=1&sn=${this.sn}&session_id=${encodeURIComponent(this.sessionId)}`
  }

  #connect (resume: boolean) {
    // 防重入: OPEN / CONNECTING 中不重复建连
    if (this.busy) return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    const handlers = this.handlers
    if (!handlers) return
    this.busy = true
    const ws = new WebSocket(this.#resumeUrl(resume))
    this.ws = ws
    ws.on('open', () => {
      // 等待服务端 HELLO; 心跳在 HELLO 成功后启动
      this.busy = false
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
        return // 非 JSON 数据忽略
      }
      switch (body.s) {
        case 1: // 握手 HELLO
          this.#onHello(body.d)
          return
        case 0: // 事件 (含聊天与系统通知)
          this.#onEvent(body.d, body.sn)
          return
        case 3: // 心跳 PONG
          this.#onPong()
          return
        case 5: // 服务端要求重连: 清空本地状态后全新连接
          logger.warn('[Kook] 收到服务端 RECONNECT 指令, 重新连接')
          this.sn = 0
          this.sessionId = ''
          this.resumeFailed = false
          ws.close()
          return
        default: // s=6 RESUME ACK 等, 无需额外处理
      }
    })
    ws.on('error', (err) => handlers.onError(err))
    ws.on('close', (code, reason) => {
      this.busy = false
      this.ws = undefined
      this.#stopHeartbeat()
      handlers.onClose()
      if (this.stopped) return
      if (code === 4004 || code === 4010 || /token|auth|401/i.test(reason?.toString() || '')) {
        // 鉴权失败: 重连无意义, 仅作一次提示避免刷屏
        logger.warn('[Kook] Token 鉴权失败: 请检查 kookToken 是否正确')
        return
      }
      logger.warn(`[Kook] Gateway 连接断开 (code=${code}), 5s 后重连`)
      this.#scheduleReconnect(5000)
    })
  }

  /** 握手 HELLO (s=1): code=0 成功并记录 session_id */
  #onHello (d: any) {
    const handlers = this.handlers
    if (!handlers) return
    const code = d?.code
    if (code !== undefined && code !== 0) {
      if (/4010[123]/.test(String(code))) {
        // token 无效/验证失败/过期: 重连无意义
        handlers.onError(new Error(`Kook Token 无效 (握手错误码 ${code}): 请检查 kookToken`))
        return
      }
      // resume 失败(40107/40108 等): 清空上下文, 转重新获取 gateway 全新连接
      logger.warn(`[Kook] 握手失败 (code=${code}), 转全新连接`)
      this.sn = 0
      this.sessionId = ''
      this.resumeFailed = true
      this.ws?.close()
      return
    }
    if (typeof d?.session_id === 'string') this.sessionId = d.session_id
    this.#startHeartbeat()
    handlers.onOpen()
  }

  /** 事件 (s=0): 按 sn 去重后交给上层 */
  #onEvent (d: any, sn: number) {
    const handlers = this.handlers
    if (!handlers) return
    if (typeof sn === 'number' && sn <= this.sn) return // 已处理过, 丢弃
    if (typeof sn === 'number') this.sn = sn
    handlers.onMessage(d)
  }

  /** 心跳 PONG (s=3): 清零超时判定 */
  #onPong () {
    if (this.pingTimer) {
      clearTimeout(this.pingTimer)
      this.pingTimer = undefined
    }
  }

  /** Kook 应用层心跳: 每 30s(+/-5s) 主动发 {s:2,sn}; 6s 未收到 PONG 判定失联并重连 */
  #startHeartbeat () {
    this.#stopHeartbeat()
    const base = this.cfg.heartbeatInterval || 30000
    const tick = () => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      try {
        this.ws.send(JSON.stringify({ s: 2, sn: this.sn }))
      } catch { /* 静默 */ }
      if (this.pingTimer) clearTimeout(this.pingTimer)
      this.pingTimer = setTimeout(() => {
        logger.warn('[Kook] 心跳 PONG 超时, 主动断开重连')
        this.ws?.close()
      }, 6000)
    }
    tick()
    this.heartbeatTimer = setInterval(tick, base + Math.floor((Math.random() - 0.5) * 10000))
  }

  #stopHeartbeat () {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
    }
    if (this.pingTimer) {
      clearTimeout(this.pingTimer)
      this.pingTimer = undefined
    }
  }

  /** 断线/心跳超时后重连: 优先 resume, 否则重新获取 gateway 全新连接 */
  #scheduleReconnect (delay: number) {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.reconnectTimer = setTimeout(() => this.#doReconnect(), delay)
  }

  async #doReconnect () {
    if (this.stopped) return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    // 具备 resume 条件时优先续传 (补发断线期间的离线消息)
    if (!this.resumeFailed && this.sessionId && this.sn > 0) {
      this.#connect(true)
      return
    }
    // 否则重新获取 gateway 全新连接
    let url = this.gatewayUrl
    try {
      const next = await this.handlers?.onReconnect?.()
      if (next) url = next
    } catch { /* 沿用旧地址 */ }
    if (this.stopped) return
    this.gatewayUrl = url
    this.sn = 0
    this.sessionId = ''
    this.#connect(false)
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

class KookWebHookChannel implements KookEventChannel {
  readonly mode = 'webhook' as const
  readonly address: string
  private server?: Server
  private stopped = false

  constructor (private readonly cfg: BotConfig) {
    const { host, port } = this.#parseListen()
    this.address = `http://${host}:${port}/webhook/kook`
  }

  get isConnected () {
    return this.server !== undefined
  }

  /** 解析本端 WebHook 监听地址, 形如 0.0.0.0:8091 */
  #parseListen (): { host: string; port: number } {
    const raw = (this.cfg.kookWebhookUrl || '').trim()
    const m = /^(.+):(\d{1,5})$/.exec(raw)
    if (!m) {
      throw new Error('Kook WebHook 模式需要本端监听地址 kookWebhookUrl, 形如 0.0.0.0:8091 (Kook 开发者后台回调填 http://公网IP:8091/webhook/kook)')
    }
    return { host: m[1], port: Number(m[2]) }
  }

  start (handlers: KookEventHandlers) {
    this.stopped = false
    if (this.server) return
    const { host, port } = this.#parseListen()
    const path = '/webhook/kook'
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
          // Kook WebHook 上线验证: s=0 + d.type=255 的 challenge 需原样返回
          if (parsed?.s === 0 && parsed?.d?.type === 255 && typeof parsed?.d?.challenge === 'string') {
            res.writeHead(200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ code: 0, challenge: parsed.d.challenge }))
            return
          }
          // Kook WebHook 推送格式与 Gateway 一致: {s:2, d: 事件, sn}
          if (parsed && typeof parsed === 'object' && 'd' in parsed && parsed.s === 2) {
            handlers.onMessage(parsed.d)
          } else {
            handlers.onMessage(parsed)
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
      logger.info(`[Kook] WebHook 服务已监听: ${this.address} (Kook 开发者后台「事件回调」填写此地址)`)
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

/** 依据 cfg.kookEventMode 创建事件接收通道 (默认 ws) */
export const createKookEventChannel = (cfg: BotConfig): KookEventChannel => {
  const mode: KookEventMode = cfg.kookEventMode ?? 'ws'
  if (mode === 'webhook') return new KookWebHookChannel(cfg)
  return new KookWsChannel(cfg)
}