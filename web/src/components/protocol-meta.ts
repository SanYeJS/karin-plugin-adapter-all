/** 协议与实现的展示名 供下拉框选用 */

export const PROTOCOL_TEXT: Record<string, string> = {
  onebot11: 'OneBot 11',
  onebot12: 'OneBot 12',
  icqq: 'ICQQ',
  milky: 'Milky',
  kook: 'Kook',
  qqbot: 'QQBot',
}

/** Kook / QQBot 事件接收方式展示名 (ws=官方网关, webhook=本端 HTTP 回调) */
export const EVENT_MODE_TEXT: Record<string, string> = {
  ws: '官方 WebSocket 网关',
  webhook: 'WebHook 回调',
}

export const IMPL_TEXT: Record<string, string> = {
  snowluma: 'SnowLuma',
  napcat: 'NapCat',
  lagrange: 'Lagrange',
  std: 'OneBot11',
}

/** OneBot11 通信方式展示名 */
export const COMMUNICATION_TEXT: Record<string, string> = {
  http: 'HTTP POST',
  ws: '正向 WebSocket',
  'ws-reverse': '反向 WebSocket',
  sse: 'HTTP SSE',
}