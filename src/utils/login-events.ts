import { logger } from 'node-karin'

/**
 * 登录验证事件总线
 *
 * icqq 等协议端在登录验证流程 (滑块/登录验证/设备锁) 各环节调用 emitLoginEvent 上报,
 * server.ts 的 SSE 端点订阅后将状态推送给 WebUI, 用户可在网页中打开验证链接完成操作。
 */

/** 登录验证阶段 (WebUI 按此展示状态徽章) */
export type LoginPhase =
  | 'idle'
  | 'slider'
  | 'auth'
  | 'device'
  | 'submitting'
  | 'relogin'
  | 'online'
  | 'failed'

/** 单条登录验证事件 (SSE 推送给 WebUI) */
export interface LoginEvent {
  /** 时间戳 (ms) */
  time: number
  /** 事件类型 */
  type: 'slider' | 'auth' | 'device' | 'submit' | 'progress' | 'relogin' | 'online' | 'offline' | 'failed' | 'timeout'
  /** 标题 */
  title: string
  /** 补充说明 */
  message?: string
  /** 需要用户打开的验证链接 */
  url?: string
  /** 设备锁验证可用手机号 (为空/缺失表示仅能网页验证, 短信通道不可用) */
  phone?: string
}

/** 单个 bot 的登录验证状态 */
export interface LoginState {
  /** QQ 号 */
  uin: string
  /** 当前阶段 */
  phase: LoginPhase
  /** 最近一次需要用户打开的验证链接 */
  url?: string
  /** 设备锁验证可用手机号 (为空/缺失表示仅能网页验证) */
  phone?: string
  /** 最近事件 (最多保留 MAX_EVENTS 条) */
  events: LoginEvent[]
}

/** 各 bot 的登录状态 (key: QQ 号) */
const states = new Map<string, LoginState>()

/** SSE 订阅客户端 (express Response) */
const subscribers = new Set<any>()

/** 单个状态最多保留的事件数 */
const MAX_EVENTS = 30

/** 事件类型 → 阶段推进 (未列出的事件类型不推进阶段) */
const phaseOf: Partial<Record<LoginEvent['type'], LoginPhase>> = {
  slider: 'slider',
  auth: 'auth',
  device: 'device',
  submit: 'submitting',
  relogin: 'relogin',
  online: 'online',
  offline: 'idle',
  failed: 'failed',
  timeout: 'failed',
}

/** 推送 payload 到所有订阅者 */
const broadcast = (payload: string) => {
  for (const res of [...subscribers]) {
    try {
      res.write(`data: ${payload}\n\n`)
    } catch {
      // 客户端已断开, 移除该订阅者
      subscribers.delete(res)
    }
  }
}

/**
 * 上报一次登录验证事件 (协议适配器在验证流程各环节调用)
 * 记录状态并增量推送给所有 WebUI 订阅者
 */
export const emitLoginEvent = (uin: string, event: Omit<LoginEvent, 'time'>) => {
  const key = String(uin ?? '').trim()
  if (!key) return
  let state = states.get(key)
  if (!state) {
    state = { uin: key, phase: 'idle', events: [] }
    states.set(key, state)
  }
  const full: LoginEvent = { ...event, time: Date.now() }
  state.events.push(full)
  if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS)
  if (full.url) state.url = full.url
  if ('phone' in full) state.phone = full.phone || ''
  const phase = phaseOf[full.type]
  if (phase) state.phase = phase
  broadcast(JSON.stringify({ snapshot: false, state }))
  logger.bot('debug', key, `[web] 登录事件: ${full.title}${full.message ? ` - ${full.message}` : ''}`)
}

/**
 * 订阅登录事件流 (SSE):
 * 连接后立即推送全部状态快照, 之后增量推送;
 * 附带 30s 心跳注释行, 防止代理/浏览器超时断开
 */
export const subscribeLoginSSE = (res: any) => {
  subscribers.add(res)
  try {
    res.write(`data: ${JSON.stringify({ snapshot: true, states: [...states.values()] })}\n\n`)
  } catch {
    /* 客户端立即断开 */
  }
  const timer = setInterval(() => {
    try {
      res.write(': ping\n\n')
    } catch {
      /* 客户端已断开, 由 close 事件清理 */
    }
  }, 30_000)
  res.on('close', () => {
    clearInterval(timer)
    subscribers.delete(res)
  })
}

/** 清除某个 QQ 号的登录状态 (bot 停止时调用) */
export const clearLoginState = (uin: string) => {
  const key = String(uin ?? '').trim()
  if (!key) return
  if (states.delete(key)) broadcast(JSON.stringify({ snapshot: false, removed: key }))
}