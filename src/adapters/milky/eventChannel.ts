import { createServer, type Server } from 'node:http'
import { logger } from 'node-karin'
import WebSocket from 'ws'
import type { BotConfig } from '../base'

/** milky 事件接收方式 */
export type MilkyEventMode = 'ws' | 'sse' | 'webhook'

/** 事件通道回调 (由 MilkyBot 绑定) */
export interface MilkyEventHandlers {
  /** 连接建立 / 服务启动 */
  onOpen: () => void
  /** 收到一条 milky 事件 (已 JSON.parse) */
  onMessage: (event: any) => void
  /** 错误(带 message) */
  onError: (err: Error) => void
  /** 连接断开 (WebHook 模式恒不触发) */
  onClose: () => void
}

/**
 * milky 事件接收通道:
 *  - ws      WebSocket: 本端连接 ws://{url}/event (Bearer 鉴权, 心跳 + 断线重连)
 *  - sse     SSE: 本端 GET {url}/event 订阅事件流 (Bearer 鉴权, 断线重连)
 *  - webhook 本端开启 HTTP 服务器 接收协议端 POST 推送 (校验 Bearer 可选)
 */
export interface MilkyEventChannel {
  readonly mode: MilkyEventMode
  /** 当前是否已连接 / 服务是否已监听 */
  readonly isConnected: boolean
  /** 对外展示的事件地址 */
  readonly address: string
  /** 启动事件接收 (可重复调用; ws/sse 断开后按 cfg.reconnect 自动重连) */
  start (handlers: MilkyEventHandlers): void
  /** 停止接收并断开 (不再重连) */
  stop (): void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 由协议端地址拼出 {url}/event (sse 保持 http, ws 转 ws) */
const eventUrlOf = (cfg: BotConfig, toWs: boolean): string => {
  const base = cfg.url.endsWith('/') ? cfg.url : `${cfg.url}/`
  const url = new URL('event', base)
  if (toWs && url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  }
  return url.toString()
}

/* ==================== WebSocket ==================== */

class MilkyWsChannel implements MilkyEventChannel {
  readonly mode = 'ws' as const
  readonly address: string
  private ws?: WebSocket
  private stopped = false
  private busy = false
  private reconnectTimer?: NodeJS.Timeout
  private heartbeatTimer?: NodeJS.Timeout

  constructor (private readonly cfg: BotConfig) {
    this.address = eventUrlOf(cfg, true)
  }

  get isConnected () {
    return this.ws?.readyState === WebSocket.OPEN
  }

  start (handlers: MilkyEventHandlers) {
    this.stopped = false
    this.#connect(handlers)
  }

  #connect (handlers: MilkyEventHandlers) {
    // 防重入: OPEN / CONNECTING 中不重复建连
    if (this.busy) return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    this.busy = true
    const ws = new WebSocket(this.address, {
      headers: { authorization: `Bearer ${this.cfg.accessToken || ''}` },
    })
    this.ws = ws
    ws.on('open', () => {
      this.busy = false
      this.#startHeartbeat()
      handlers.onOpen()
    })
    ws.on('message', (data: Buffer | string) => {
      try {
        handlers.onMessage(JSON.parse(data.toString()))
      } catch {
        // 非 JSON 数据忽略
      }
    })
    ws.on('error', (err) => handlers.onError(err))
    ws.on('close', (code, reason) => {
      this.busy = false
      this.ws = undefined
      this.#stopHeartbeat()
      handlers.onClose()
      if (this.stopped) return
      if (code === 1008 || /auth|token|401/i.test(reason?.toString() || '')) {
        // 鉴权失败: 重连无意义, 仅作一次提示避免刷屏
        logger.warn('[Milky] Token 鉴权失败: 请检查 accessToken 与协议端一致')
        return
      }
      if (this.cfg.reconnect !== false) {
        logger.warn(`[Milky] 事件连接断开 (code=${code}), 5s 后重连`)
        this.reconnectTimer = setTimeout(() => this.#connect(handlers), 5000)
      }
    })
  }

  #startHeartbeat () {
    this.#stopHeartbeat()
    const interval = this.cfg.heartbeatInterval || 30000
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        try { this.ws.ping() } catch { /* 静默 */ }
      }
    }, interval)
  }

  #stopHeartbeat () {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer)
      this.heartbeatTimer = undefined
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

/* ==================== SSE ==================== */

class MilkySseChannel implements MilkyEventChannel {
  readonly mode = 'sse' as const
  readonly address: string
  private aborter?: AbortController
  private stopped = false
  private connected = false
  private streamTask?: Promise<void>

  constructor (private readonly cfg: BotConfig) {
    this.address = eventUrlOf(cfg, false)
  }

  get isConnected () {
    return this.connected
  }

  start (handlers: MilkyEventHandlers) {
    this.stopped = false
    if (this.streamTask) return
    this.streamTask = this.#loop(handlers).finally(() => { this.streamTask = undefined })
  }

  /** 读取循环: 断线重连 (鉴权失败不再重连) */
  async #loop (handlers: MilkyEventHandlers) {
    while (!this.stopped) {
      try {
        await this.#pipe(handlers)
        break
      } catch (e) {
        if (this.stopped) break
        this.connected = false
        handlers.onClose()
        if (this.#isAuthError(e)) {
          logger.warn('[Milky] Token 鉴权失败: 请检查 accessToken 与协议端一致')
          handlers.onError(e as Error)
          break
        }
        if (this.cfg.reconnect !== false) {
          logger.warn(`[Milky] 事件流断开: ${(e as Error).message}, 5s 后重连`)
          handlers.onError(e as Error)
          await sleep(5000)
          continue
        }
        handlers.onError(e as Error)
        break
      }
    }
  }

  /** 建立并消费一次事件流 */
  async #pipe (handlers: MilkyEventHandlers) {
    const controller = new AbortController()
    this.aborter = controller
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    }
    if (this.cfg.accessToken) headers.Authorization = `Bearer ${this.cfg.accessToken}`
    const res = await fetch(this.address, { headers, signal: controller.signal })
    if (!res.ok || !res.body) {
      const err: any = new Error(`[Milky] 连接失败: HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    this.connected = true
    handlers.onOpen()
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let dataParts: string[] = []
    const flush = () => {
      if (dataParts.length === 0) return
      const raw = dataParts.join('\n')
      dataParts = []
      try {
        handlers.onMessage(JSON.parse(raw))
      } catch {
        // 非 JSON 数据忽略
      }
    }
    for (; ;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        if (line === '') {
          flush()
        } else if (line.startsWith('data:')) {
          dataParts.push(line.slice(5).trim())
        }
        // event: / retry: 等字段忽略
      }
    }
    flush()
    this.connected = false
    if (!this.stopped) throw new Error('事件流已断开')
  }

  stop () {
    this.stopped = true
    this.connected = false
    this.aborter?.abort()
    this.aborter = undefined
  }

  #isAuthError (e: any) {
    const m = String(e?.message || '')
    return e?.status === 401 || e?.status === 403 || /401|403|auth|token/i.test(m)
  }
}

/* ==================== WebHook ==================== */

class MilkyWebHookChannel implements MilkyEventChannel {
  readonly mode = 'webhook' as const
  readonly address: string
  private server?: Server
  private stopped = false

  constructor (private readonly cfg: BotConfig) {
    const { host, port } = this.#listen()
    this.address = `http://${host}:${port}/webhook`
  }

  get isConnected () {
    return this.server !== undefined
  }

  /** 解析 eventUrl(本端 WebHook 监听地址, 形如 0.0.0.0:8088) */
  #listen (): { host: string; port: number } {
    const raw = (this.cfg.eventUrl || '').trim()
    const hashIdx = raw.lastIndexOf('#')
    let target = hashIdx >= 0 ? raw.slice(hashIdx + 1) : raw
    const m = /^(.+):(\d{1,5})$/.exec(target)
    if (!m) {
      throw new Error('milky WebHook 模式需要本端监听地址 eventUrl, 形如 0.0.0.0:8088 (协议端 WebHook 填 http://本机IP:8088/webhook)')
    }
    return { host: m[1], port: Number(m[2]) }
  }

  start (handlers: MilkyEventHandlers) {
    this.stopped = false
    if (this.server) return
    const { host, port } = this.#listen()
    const path = '/webhook'
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || (req.url || '').split('?')[0] !== path) {
        res.writeHead(404, { 'Content-Type': 'application/json' })
        res.end('{}')
        return
      }
      // 鉴权: 协议端推送时携带 Authorization: Bearer <token> (配置了才校验)
      if (this.cfg.accessToken) {
        const auth = req.headers.authorization || ''
        if (auth !== `Bearer ${this.cfg.accessToken}`) {
          res.writeHead(401, { 'Content-Type': 'application/json' })
          res.end('{}')
          return
        }
      }
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
        if (body.length > 10 * 1024 * 1024) req.destroy()
      })
      req.on('end', () => {
        try {
          handlers.onMessage(JSON.parse(body))
        } catch {
          // 非 JSON 数据忽略
        }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end('{}')
      })
    })
    server.on('error', (err) => handlers.onError(err))
    server.listen(port, host, () => {
      this.server = server
      handlers.onOpen()
      logger.info(`[Milky] WebHook 服务已监听: http://${host}:${port}${path} (协议端 WebHook 填写此地址)`)
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

/** 依据 cfg.eventMode 创建事件接收通道 (默认 ws) */
export const createMilkyEventChannel = (cfg: BotConfig): MilkyEventChannel => {
  const mode: MilkyEventMode = cfg.eventMode ?? 'ws'
  if (mode === 'sse') return new MilkySseChannel(cfg)
  if (mode === 'webhook') return new MilkyWebHookChannel(cfg)
  return new MilkyWsChannel(cfg)
}