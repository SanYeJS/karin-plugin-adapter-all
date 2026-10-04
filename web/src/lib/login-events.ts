/**
 * 登录验证事件 (SSE) 客户端
 *
 * 订阅后端 ${WEB_PREFIX}/api/login/events 事件流, 按 QQ 号维护各 bot 的登录验证状态
 * (滑块/登录验证/设备锁链接与进度), 供 icqq bot 卡片展示。连接在首次订阅时自动建立,
 * EventSource 断线后由浏览器自动重连, 重连后收到全量快照恢复状态。
 */

import { useCallback, useEffect, useSyncExternalStore } from 'react'
import { resolveHost } from './api'

/** 登录验证阶段 (与后端 src/utils/login-events.ts 对应) */
export type LoginPhase =
  | 'idle'
  | 'slider'
  | 'auth'
  | 'device'
  | 'submitting'
  | 'relogin'
  | 'online'
  | 'failed'

/** 单条登录验证事件 */
export interface LoginEvent {
  /** 时间戳 (ms) */
  time: number
  type: 'slider' | 'auth' | 'device' | 'submit' | 'progress' | 'relogin' | 'online' | 'offline' | 'failed' | 'timeout'
  title: string
  message?: string
  url?: string
  /** 设备锁验证可用手机号 (为空/缺失表示仅能网页验证) */
  phone?: string
}

/** 单个 bot 的登录验证状态 */
export interface LoginState {
  uin: string
  phase: LoginPhase
  /** 最近一次需要用户打开的验证链接 */
  url?: string
  /** 设备锁验证可用手机号 (为空/缺失表示仅能网页验证) */
  phone?: string
  events: LoginEvent[]
}

/** 各 bot 的登录状态 (key: QQ 号) */
const states = new Map<string, LoginState>()

/** 状态变更监听器 */
const listeners = new Set<() => void>()

let es: EventSource | null = null
let initialized = false

const emitChange = () => {
  for (const fn of [...listeners]) fn()
}

/** 应用一条 SSE 消息 */
const applyPayload = (data: any) => {
  if (data?.snapshot && Array.isArray(data.states)) {
    // 全量快照 (重连后恢复)
    states.clear()
    for (const s of data.states) states.set(String(s.uin), s)
  } else if (data?.removed) {
    states.delete(String(data.removed))
  } else if (data?.state) {
    // 增量更新: 后端每次上报都携带完整 state, 直接替换对象引用以触发订阅者重渲染
    states.set(String(data.state.uin), data.state)
  }
  emitChange()
}

/** 建立全局 SSE 连接 (幂等) */
const initLoginEvents = () => {
  if (initialized) return
  initialized = true
  try {
    es = new EventSource(`${resolveHost()}/adapter-all/api/login/events`)
  } catch {
    return
  }
  es.onmessage = (ev) => {
    try {
      applyPayload(JSON.parse(ev.data))
    } catch {
      /* 忽略解析失败的消息 */
    }
  }
  // es.onerror 无需处理: EventSource 内置自动重连
}

/** 读取某个 QQ 号的登录状态 (供 useSyncExternalStore 快照) */
const getLoginState = (uin: string): LoginState | undefined =>
  states.get(String(uin ?? '').trim())

/** 订阅某个 QQ 号的登录状态 (组件内使用; 首次订阅时自动建立 SSE 连接) */
export const useLoginState = (uin: string): LoginState | undefined => {
  const key = String(uin ?? '').trim()
  useEffect(() => {
    if (key) initLoginEvents()
  }, [key])
  const subscribe = useCallback((cb: () => void) => {
    listeners.add(cb)
    return () => {
      listeners.delete(cb)
    }
  }, [])
  return useSyncExternalStore(subscribe, () => getLoginState(uin))
}