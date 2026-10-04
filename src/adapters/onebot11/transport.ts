import type { BotConfig } from '../base'
import { OneBot11WSClient } from './wsClient'
import { OneBot11WSServer } from './wsServer'
import { OneBot11HTTP } from './http'
import { OneBot11SSE } from './sse'

/** OneBot11 数据上报类型 dispatch 时使用 */
export interface OneBot11Event { post_type?: string;[k: string]: any }

/**
 * OneBot11 传输层统一接口
 * 三种通信方式(正向WS/反向WS/HTTP)对外行为一致:
 *  - connect(): 建立连接/开始监听 幂等
 *  - close(): 关闭连接/服务 不再重连
 *  - call(): 执行 OneBot11 action 按 echo/HTTP响应匹配回包
 *  - 事件: open/close/error/message/notice/request/metaEvent
 */
export interface OneBot11Transport {
  readonly isConnected: boolean
  connect (): Promise<void>
  close (): void
  call<T = any> (action: string, params?: any): Promise<T>
  on (event: string, listener: (...args: any[]) => void): unknown
}

/** 按通信方式创建 OneBot11 传输层 */
export const createOneBot11Transport = (cfg: BotConfig): OneBot11Transport => {
  switch (cfg.communication ?? 'ws') {
    case 'ws':
      // 正向 WS: 本端作为服务端 监听 url 协议端主动连接
      return new OneBot11WSServer(cfg.url, cfg.accessToken, cfg.requestTimeout)
    case 'ws-reverse':
      // 反向 WS: 本端作为客户端 连接协议端 WS 地址
      return new OneBot11WSClient(cfg.url, cfg.accessToken, cfg.reconnect, cfg.requestTimeout, cfg.heartbeatInterval)
    case 'http':
      // HTTP: url 为协议端 HTTP API 地址 事件上报监听 eventUrl
      return new OneBot11HTTP(cfg.url, cfg.eventUrl, cfg.accessToken, cfg.requestTimeout)
    case 'sse':
      // HTTP SSE: url 为协议端 HTTP API 地址 eventUrl 为协议端 SSE 事件流地址
      return new OneBot11SSE(cfg.url, cfg.eventUrl, cfg.accessToken, cfg.requestTimeout, cfg.reconnect)
  }
}