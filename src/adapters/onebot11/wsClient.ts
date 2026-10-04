import { EventEmitter } from 'node:events'
import WebSocket from 'ws'
import { logger } from 'node-karin'

/** OneBot11 数据上报类型 */
interface OneBot11Event { post_type?: string;[k: string]: any }

/** 挂起的 action 调用 (按 echo 匹配) */
export interface OneBot11PendingEntry { resolve: (v: any) => void; reject: (e: Error) => void }

/**
 * 解析一条 OneBot11 数据:
 *  - 含 echo → API 回包, 从 pending 取出回调 resolve/reject (返回 true)
 *  - 否则按 post_type 分发事件: message / notice / request / metaEvent (返回 true)
 *  - 非法 JSON → false
 * 正向 WS / 反向 WS / HTTP 三种传输共用
 */
export const dispatchOneBot11Payload = (
  raw: string,
  pending: Map<string, OneBot11PendingEntry>,
  emit: (event: string, ...args: any[]) => void,
) => {
  let e: OneBot11Event
  try { e = JSON.parse(raw) } catch { return false }
  if (e?.echo !== undefined) {
    const p = pending.get(String(e.echo))
    if (!p) return true
    pending.delete(String(e.echo))
    e.status === 'ok' && e.retcode === 0
      ? p.resolve(e.data)
      : p.reject(new Error(`[OneBot11] action 失败(echo=${e.echo}): ${e.message || e.retcode || 'unknown'}`))
    return true
  }
  switch (e?.post_type) {
    case 'message': emit('message', e); return true
    case 'notice': emit('notice', e); return true
    case 'request': emit('request', e); return true
    case 'meta_event': emit('metaEvent', e); return true
    default: emit('message', e); return true
  }
}

/**
 * 通用 OneBot11 WS 客户端 (正向连接)
 * 供 napcat / lagrange 等标准 OneBot11 实现使用
 * 数据上报按 post_type 分发: message / notice / request / meta_event
 */
export class OneBot11WSClient extends EventEmitter {
  private ws?: WebSocket
  private seq = 0
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>()
  private _isConnected = false
  private _closed = false
  private connecting?: Promise<void>
  private heartbeatTimer?: NodeJS.Timeout
  /** 鉴权失败提示已输出过, 避免周期性重连刷屏 */
  private authWarned = false

  constructor (
    private readonly url: string,
    private readonly accessToken?: string,
    private readonly autoReconnect = false,
    private readonly requestTimeout = 15000,
    private readonly heartbeatInterval?: number,
  ) {
    super()
  }

  get isConnected () {
    return this._isConnected
  }

  /** 连接 重复调用幂等 连接成功后触发 open 事件 */
  connect (): Promise<void> {
    if (this._isConnected) return Promise.resolve()
    if (this.connecting) return this.connecting
    this.connecting = new Promise((resolve, reject) => {
      // 鉴权: query access_token + Authorization Bearer 双通道, 兼容不同协议端
      const url = this.accessToken
        ? `${this.url}${this.url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(this.accessToken)}`
        : this.url
      const ws = new WebSocket(url, {
        headers: this.accessToken ? { Authorization: `Bearer ${this.accessToken}` } : undefined,
      })
      this.ws = ws
      const onOpen = () => {
        this._isConnected = true
        this.connecting = undefined
        this.startHeartbeat()
        this.emit('open')
        resolve()
      }
      const onError = (err: any) => {
        this.connecting = undefined
        this.emit('error', err)
        reject(new Error(`[OneBot11WS] 连接失败: ${err?.message || err}`))
      }
      ws.once('open', onOpen)
      ws.once('error', onError)
      ws.on('message', (data) => this.dispatch(data.toString()))
      ws.on('error', (err) => {
        if (this._isConnected) logger.error(`[OneBot11WS] 连接错误: ${err.message}`)
      })
      ws.on('close', (code, reason) => {
        this._isConnected = false
        this.stopHeartbeat()
        this.ws = undefined
        this.emit('close')
        // 鉴权相关问题: 只作一次简短提示, 避免周期性重连刷屏
        const r = reason?.toString() || ''
        if (!this.authWarned && (code === 1008 || code === 4001 || /auth|token|401/i.test(r))) {
          this.authWarned = true
          logger.warn('[OneBot11] Token 鉴权失败: 请检查 accessToken 与服务端一致')
        } else if (code !== 1000 && code !== 1005 && this._closed === false) {
          // 握手成功但随被服务端断开: 简短提示原因, 不打断重连
          logger.warn(`[OneBot11] 连接断开: ${this.url} (code=${code})`)
        }
        if (!this._closed && this.autoReconnect) {
          setTimeout(() => { this.connect().catch(() => { }) }, 5000)
        }
      })
    })
    return this.connecting
  }

  /** 主动断开 不再重连 */
  close () {
    this._closed = true
    this.stopHeartbeat()
    this.ws?.close()
  }

  /** 开启心跳 ping */
  private startHeartbeat () {
    if (!this.heartbeatInterval) return
    this.stopHeartbeat()
    this.heartbeatTimer = setInterval(() => {
      try { this.ws?.ping?.() } catch { /* 连接已断开 */ }
    }, this.heartbeatInterval)
  }

  /** 关闭心跳 */
  private stopHeartbeat () {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = undefined
  }

  /** 调用 OneBot11 action 按 echo 匹配响应 */
  call<T = any> (action: string, params?: any): Promise<T> {
    return new Promise((resolve, reject) => {
      const ws = this.ws
      if (!ws || ws.readyState !== WebSocket.OPEN) return reject(new Error(`[OneBot11WS] 未连接，无法调用: ${action}`))
      const echo = `${Date.now()}-${++this.seq}`
      this.pending.set(echo, { resolve, reject })
      ws.send(JSON.stringify({ action, params, echo }))
      setTimeout(() => {
        if (!this.pending.delete(echo)) return
        reject(new Error(`[OneBot11WS] action 超时: ${action}`))
      }, this.requestTimeout)
    })
  }

  /** 数据分发: 响应回包 vs 事件上报 */
  private dispatch (data: string) {
    if (!dispatchOneBot11Payload(data, this.pending, (ev, ...args) => this.emit(ev, ...args))) {
      logger.debug(`[OneBot11WS] 非法上报: ${data}`)
    }
  }
}