import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { logger } from 'node-karin'
import { dispatchOneBot11Payload, type OneBot11PendingEntry } from './wsClient'

const OK_RESPONSE = JSON.stringify({ status: 'ok', retcode: 0, data: null })

/**
 * OneBot11 HTTP 传输层:
 *  - API 调用: 本端作为 HTTP 客户端 POST {apiUrl}/api/{action} (Bearer 鉴权)
 *  - 事件接收: 本端作为 HTTP 服务端监听 eventUrl(本端地址) 接受协议端事件上报
 *    收到事件后按 OneBot11 契约回应 {status:'ok',retcode:0,data:null}
 */
export class OneBot11HTTP extends EventEmitter {
  private server?: Server
  private _isConnected = false
  private _closed = false
  private connecting?: Promise<void>

  constructor (
    private readonly apiUrl: string,
    private readonly eventUrl?: string,
    private readonly accessToken?: string,
    private readonly requestTimeout = 15000,
  ) {
    super()
    if (!apiUrl.trim()) throw new Error('[OneBot11HTTP] 缺少协议端 HTTP API 地址(url)')
    if (!this.eventUrl?.trim()) throw new Error('[OneBot11HTTP] HTTP 模式缺少“事件上报地址(eventUrl)”配置')
  }

  /** 事件上报服务是否在监听 */
  get isConnected () {
    return this._isConnected
  }

  /** 启动事件上报监听服务 幂等 监听成功后触发 open 事件 */
  connect (): Promise<void> {
    if (this._closed) return Promise.reject(new Error('[OneBot11HTTP] 已关闭，无法再次监听'))
    if (this.server) return Promise.resolve()
    if (this.connecting) return this.connecting
    this.connecting = new Promise((resolve, reject) => {
      try {
        let u: URL
        try { u = new URL(this.eventUrl!) } catch { throw new Error(`非法事件上报地址: ${this.eventUrl}`) }
        const port = Number(u.port || (u.protocol === 'https:' ? '443' : '80'))
        const host = u.hostname || '0.0.0.0'
        const server = createServer((req, res) => void this.handleRequest(req, res))
        this.server = server
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

  /** 停止事件上报监听服务 */
  close () {
    this._closed = true
    this._isConnected = false
    this.server?.close()
    this.server = undefined
  }

  /** 处理协议端事件上报 POST 请求 */
  private async handleRequest (req: IncomingMessage, res: ServerResponse) {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'failed', retcode: 405, message: 'method not allowed' }))
      return
    }
    try {
      const raw = await readBody(req)
      if (!raw.trim()) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(OK_RESPONSE)
        return
      }
      if (!dispatchOneBot11Payload(raw, new Map(), (ev, ...args) => this.emit(ev, ...args))) {
        logger.debug(`[OneBot11HTTP] 非法上报: ${raw}`)
      }
      // OneBot11 事件上报响应契约: 固定回 ok (审批等后续通过 API 方式处理)
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(OK_RESPONSE)
    } catch (e) {
      logger.warn(`[OneBot11HTTP] 处理事件上报失败: ${(e as Error).message || e}`)
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ status: 'failed', retcode: 400, message: 'bad request' }))
    }
  }

  /** 调用 OneBot11 action 走协议端 HTTP API */
  async call<T = any> (action: string, params?: any): Promise<T> {
    const base = this.apiUrl.trim().replace(/\/+$/, '')
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.accessToken?.trim()) headers.Authorization = `Bearer ${this.accessToken.trim()}`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), this.requestTimeout)
    try {
      const res = await fetch(`${base}/api/${action}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(params ?? {}),
        signal: ctrl.signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const json: any = await res.json().catch(() => ({}))
      if (json.status === 'ok' && json.retcode === 0) return json.data
      throw new Error(`[OneBot11HTTP] action 失败(${action}): ${json.message || json.retcode || 'unknown'}`)
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 读取请求 body (限制 10MB) */
const readBody = (req: IncomingMessage) => new Promise<string>((resolve, reject) => {
  let data = ''
  req.on('data', (chunk) => {
    data += chunk
    if (data.length > 10 * 1024 * 1024) {
      reject(new Error('body 超过 10MB'))
      req.destroy()
    }
  })
  req.on('end', () => resolve(data))
  req.on('error', reject)
})