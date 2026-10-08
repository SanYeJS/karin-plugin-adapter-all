import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, Server } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import { logger } from 'node-karin'
import { dispatchOneBot11Payload, type OneBot11PendingEntry } from './wsClient'

/**
 * OneBot11 反向 WS 服务端:
 * 本端作为 WebSocket 服务端监听 url(本端地址) 接受协议端(OneBot)主动连接
 * 在同一连接上完成 action 调用(echo配对)与事件推送
 * 鉴权: 配置 accessToken 时校验连接方携带的 token(可选) 未配置则接受任意连接
 */
export class OneBot11WSServer extends EventEmitter {
  private server?: Server
  private wss?: WebSocketServer
  private seq = 0
  private pending = new Map<string, OneBot11PendingEntry>()
  private _isConnected = false
  private _closed = false
  private connecting?: Promise<void>
  /** 已连接的协议端客户端 (Map: socket -> 连接时间) */
  private clients = new Map<WebSocket, number>()
  private last?: WebSocket

  constructor (
    private readonly url: string,
    private readonly accessToken?: string,
    private readonly requestTimeout = 15000,
  ) {
    super()
  }

  /** 是否有协议端客户端在线 */
  get isConnected () {
    return this.clients.size > 0
  }

  /** 开始监听 幂等 监听成功后触发 open 事件 */
  connect (): Promise<void> {
    if (this._closed) return Promise.reject(new Error(`[OneBot11WSServer] 已关闭，无法再次监听: ${this.url}`))
    if (this.server) return Promise.resolve()
    if (this.connecting) return this.connecting
    this.connecting = new Promise((resolve, reject) => {
      try {
        let u: URL
        try {
          const raw = this.url.trim()
          u = new URL(/^\w+:\/\//.test(raw) ? raw.replace(/^http/i, 'ws') : `ws://${raw.replace(/^\/+/, '')}`)
        } catch { throw new Error(`非法监听地址: ${this.url}`) }
        const port = Number(u.port || (u.protocol === 'wss:' ? '443' : '80'))
        const host = u.hostname || '0.0.0.0'
        const path = u.pathname && u.pathname !== '/' ? u.pathname : undefined
        const server = createServer((_req, res) => { res.writeHead(426); res.end() })
        const wss = new WebSocketServer({ server, path })
        this.server = server
        this.wss = wss

        wss.on('connection', (ws, req) => this.handleClient(ws, req))
        wss.on('error', (err) => this.emit('error', err))

        server.on('error', (err) => {
          this.connecting = undefined
          this.emit('error', err)
          reject(err)
        })
        server.listen(port, host, () => {
          this.connecting = undefined
          this._isConnected = true
          this.emit('open')
          resolve()
        })
      } catch (e) {
        this.connecting = undefined
        this.emit('error', e)
        reject(e)
      }
    })
    return this.connecting
  }

  /** 等待协议端连接 (服务端模式下 start 探测前调用) 超时抛错 */
  waitForClient (timeout = 15000): Promise<void> {
    if (this.clients.size > 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        this.off('open', check)
        reject(new Error(`等待协议端连接超时: ${this.url}`))
      }, timeout)
      const check = () => {
        if (done || this.clients.size === 0) return
        done = true
        clearTimeout(timer)
        this.off('open', check)
        resolve()
      }
      this.on('open', check)
    })
  }

  /** 关闭监听与所有客户端连接 不再接受连接 */
  close () {
    this._closed = true
    this._isConnected = false
    for (const ws of [...this.clients.keys()]) {
      try { ws.close() } catch { /* 忽略关闭异常 */ }
    }
    this.clients.clear()
    this.last = undefined
    this.wss?.close()
    this.wss = undefined
    this.server?.close()
    this.server = undefined
  }

  /** 处理协议端连接 校验 token(可选) 并接管消息分发 */
  private handleClient (ws: WebSocket, req: IncomingMessage) {
    const u = new URL(req.url || '/', 'http://localhost')
    const qToken = u.searchParams.get('access_token')
    const auth = String(req.headers.authorization || '')
    const hToken = auth.startsWith('Bearer ') ? auth.slice(7) : (auth || undefined)
    const presented = (qToken || hToken || '').trim()
    /** 连接方来源 (IP:端口) */
    const peer = req.socket?.remoteAddress ? `${req.socket.remoteAddress}:${req.socket.remotePort}` : '未知来源'
    /** 握手路径 根路径显示为 /(根) */
    const upath = u.pathname === '/' ? '/(根)' : u.pathname
    if (this.accessToken && presented !== this.accessToken) {
      logger.warn(`[OneBot11WSServer] 拒绝非法连接(token不匹配, 来自 ${peer}): ${upath}`)
      ws.close(1008, 'unauthorized')
      return
    }
    this.clients.set(ws, Date.now())
    this.last = ws
    this.emit('open')

    ws.on('message', (data) => {
      const raw = data.toString()
      if (!dispatchOneBot11Payload(raw, this.pending, (ev, ...args) => this.emit(ev, ...args))) {
        logger.debug(`[OneBot11WSServer] 非法上报: ${raw}`)
      }
    })
    ws.on('error', (err) => logger.warn(`[OneBot11WSServer] 客户端异常: ${err.message}`))
    ws.on('close', () => {
      this.clients.delete(ws)
      if (this.last === ws) this.last = undefined
      logger.info(`[OneBot11WSServer] 协议端断开 剩余: ${this.clients.size}`)
      if (this.clients.size === 0) {
        this.emit('close')
      }
    })
  }

  /** 调用 OneBot11 action 通过最近连接的服务端发送 按 echo 匹配响应 */
  call<T = any> (action: string, params?: any): Promise<T> {
    return new Promise((resolve, reject) => {
      const ws = this.last
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return reject(new Error(`[OneBot11WSServer] 无协议端连接(反向WS)，无法调用: ${action}，请确认协议端已连接 ${this.url}`))
      }
      const echo = `${Date.now()}-${++this.seq}`
      this.pending.set(echo, { resolve, reject })
      ws.send(JSON.stringify({ action, params, echo }))
      setTimeout(() => {
        if (!this.pending.delete(echo)) return
        reject(new Error(`[OneBot11WSServer] action 超时: ${action}`))
      }, this.requestTimeout)
    })
  }
}