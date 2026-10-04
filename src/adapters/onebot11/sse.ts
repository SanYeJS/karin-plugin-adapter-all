import { EventEmitter } from 'node:events'
import { logger } from 'node-karin'
import { dispatchOneBot11Payload } from './wsClient'
import type { OneBot11Transport } from './transport'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * OneBot11 HTTP SSE 传输层:
 *  - API 调用: 本端作为 HTTP 客户端 POST {apiUrl}/api/{action} (Bearer 鉴权, 可选)
 *  - 事件接收: 本端作为 SSE 客户端连接协议端的事件流地址(eventUrl)
 *    按 SSE 协议解析 data: 行, 事件数据为 JSON, 复用统一分发逻辑
 *  - 事件流断开后自动重连 (鉴权失败 / 配置关闭自动重连除外)
 */
export class OneBot11SSE extends EventEmitter implements OneBot11Transport {
  private controller?: AbortController
  private _isConnected = false
  private _closed = false
  private streamTask?: Promise<void>

  constructor (
    private readonly apiUrl: string,
    private readonly sseUrl?: string,
    private readonly accessToken?: string,
    private readonly requestTimeout = 15000,
    /** 断线自动重连 (默认开启) */
    private readonly autoReconnect = true,
  ) {
    super()
    if (!apiUrl.trim()) throw new Error('[OneBot11SSE] 缺少协议端 API 地址(url)')
    if (!sseUrl?.trim()) throw new Error('[OneBot11SSE] SSE 模式缺少“事件流地址(eventUrl)”配置')
  }

  /** SSE 事件流是否在连接中 */
  get isConnected () {
    return this._isConnected
  }

  /** 建立 SSE 事件流连接 断线自动重连 */
  async connect (): Promise<void> {
    if (this._closed) throw new Error('[OneBot11SSE] 已关闭, 无法再次连接')
    if (this.streamTask) return
    this.streamTask = this.loop()
  }

  /** SSE 读取循环: 断线重连 (鉴权失败不再重连) */
  private async loop () {
    while (!this._closed) {
      try {
        await this.pipe()
      } catch (e) {
        if (this._closed) break
        this._isConnected = false
        this.emit('close')
        if (this.isAuthError(e)) {
          this._closed = true
          logger.warn('[OneBot11SSE] Token 鉴权失败: 请检查 accessToken 与服务端一致')
          this.emit('error', e)
          break
        }
        if (this.autoReconnect === false) {
          logger.warn(`[OneBot11SSE] 事件流断开: ${(e as Error).message || e}, 已关闭自动重连`)
          this.emit('error', e)
          break
        }
        logger.warn(`[OneBot11SSE] 事件流断开: ${(e as Error).message || e}, 5s 后重连`)
        this.emit('error', e)
        await sleep(5000)
      }
    }
  }

  /** 建立并消费一次事件流 */
  private async pipe () {
    const controller = new AbortController()
    this.controller = controller
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    }
    if (this.accessToken) headers.Authorization = `Bearer ${this.accessToken}`
    const res = await fetch(this.sseUrl!, { headers, signal: controller.signal })
    if (!res.ok || !res.body) {
      const err: any = new Error(`[OneBot11SSE] 连接失败: HTTP ${res.status}`)
      err.status = res.status
      throw err
    }
    this._isConnected = true
    this.emit('open')
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    for (; ;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let idx: number
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx).replace(/\r$/, '')
        buffer = buffer.slice(idx + 1)
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (!data || data === '[DONE]') continue
        try {
          if (!dispatchOneBot11Payload(data, new Map(), (ev, ...args) => this.emit(ev, ...args))) {
            logger.debug(`[OneBot11SSE] 非法数据: ${data}`)
          }
        } catch {
          // 非 JSON 数据忽略
        }
      }
    }
    this._isConnected = false
    if (!this._closed) throw new Error('[OneBot11SSE] 事件流已断开')
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
      throw new Error(`[OneBot11SSE] action 失败(${action}): ${json.message || json.retcode || 'unknown'}`)
    } finally {
      clearTimeout(timer)
    }
  }

  /** 关闭 SSE 事件流 不再重连 */
  close () {
    this._closed = true
    this._isConnected = false
    this.controller?.abort()
    this.controller = undefined
  }

  /** 是否鉴权类错误 (服务端拒绝, 重连无意义) */
  private isAuthError (e: any) {
    const m = String(e?.message || '')
    return e?.status === 401 || e?.status === 403 || /401|403|auth|token/i.test(m)
  }
}