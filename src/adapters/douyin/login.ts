import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'
import { logger } from 'node-karin'
import { login } from 'douyin.ts'
import type { Session, VerifyWay } from 'douyin.ts'
import { accountStore } from './store'
import { sdkLog } from './im'

/** 登录阶段 */
export type DouyinLoginPhase = 'pending' | 'scanned' | 'verifying' | 'mfa' | 'success' | 'expired' | 'error'

/** 面板轮询快照 */
export interface DouyinLoginSnapshot {
  phase: DouyinLoginPhase
  /** 二维码图片 dataURL（pending 阶段提供） */
  image?: string
  /** SDK 上报的中文状态文案 */
  statusText?: string
  /** 二次验证类型 */
  mfaKind?: 'sms' | 'password'
  /** 脱敏手机号（sms 验证时） */
  maskedMobile?: string
  /** 服务端可选二次验证方式（mfa 阶段且未选择时提供，选择后清空） */
  ways?: Array<{ way: string; mobile?: string; smsContent?: string }>
  /** 安全验证中心页地址（verifying 阶段提供，面板内 iframe 展示） */
  verifyUrl?: string
  /** 登录成功后的账号数字 uid */
  uid?: string
  /** 登录成功后的账号昵称 */
  name?: string
  /** 失败原因 */
  error?: string
}

/** 二次验证等待器 */
interface MfaWaiter {
  resolve: (code: string) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/** 验证方式选择等待器 */
interface WayWaiter {
  resolve: (way?: string) => void
  timer: NodeJS.Timeout
}

/** 进行中的扫码登录会话 */
interface DouyinLoginSession {
  id: string
  createdAt: number
  phase: DouyinLoginPhase
  /** 二维码图片 dataURL */
  image?: string
  statusText?: string
  mfaKind?: 'sms' | 'password'
  maskedMobile?: string
  ways?: Array<{ way: string; mobile?: string; smsContent?: string }>
  wayWaiter?: WayWaiter
  verifyUrl?: string
  mfaWaiter?: MfaWaiter
  uid?: string
  name?: string
  error?: string
  /** 面板已取消：登录流程完成后不再落盘 */
  cancelled?: boolean
}

/** 进行中的扫码会话表 */
const sessions = new Map<string, DouyinLoginSession>()

/** 会话有效期 15 分钟 */
const SESSION_TTL = 15 * 60 * 1000
/** 仍视为进行中的阶段（全局互斥依据） */
const ACTIVE_PHASES: ReadonlySet<DouyinLoginPhase> = new Set(['pending', 'scanned', 'verifying', 'mfa'])

/** 定时清理过期会话（含卡死的进行中会话，避免互斥锁永不释放） */
setInterval(() => {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.createdAt <= SESSION_TTL) continue
    s.mfaWaiter?.reject(new Error('登录会话已超时'))
    if (s.wayWaiter) clearTimeout(s.wayWaiter.timer)
    sessions.delete(id)
  }
}, 60 * 1000).unref?.()

/** 二维码 → dataURL：SDK 带 base64 直接用，否则由 url 本地生成 */
async function qrToDataUrl (base64?: string, url?: string): Promise<string> {
  if (base64) return base64.startsWith('data:') ? base64 : `data:image/png;base64,${base64}`
  try {
    return await QRCode.toDataURL(url || '', { width: 280, margin: 1, errorCorrectionLevel: 'M' })
  } catch {
    return ''
  }
}

/** 登录成功后落盘凭据（对齐参考插件 persist：cookie 为唯一凭据，昵称缺省沿用旧值） */
function persist (session: Session): void {
  const uid = session.userId
  const prev = accountStore.load(uid)
  const screenName = String(session.userData?.screen_name ?? '') || prev?.screenName
  accountStore.save(uid, {
    platformUid: uid,
    cookie: session.cookie,
    ...(session.userData ? { userData: session.userData as Record<string, unknown> } : {}),
    ...(screenName ? { screenName } : {}),
    createdAt: prev?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
}

/** 后台执行扫码登录全流程：回调驱动会话状态，结果驱动落盘 */
async function runLogin (session: DouyinLoginSession): Promise<void> {
  try {
    const result = await login({
      log: sdkLog,
      onQr: async qr => {
        session.phase = 'pending'
        session.image = await qrToDataUrl(qr.base64, qr.url)
        session.statusText = '请使用抖音 APP 扫码'
      },
      onStatus: s => {
        session.statusText = s
        if (s === 'scanned') session.phase = 'scanned'
        else if (s === 'verifying') session.phase = 'verifying'
        else if (s === 'expired') session.phase = 'expired'
      },
      onVerifyUrl: url => {
        session.phase = 'verifying'
        session.verifyUrl = url
        session.statusText = '需要安全验证，请在面板内完成'
      },
      onVerifyWays: raw => new Promise<string | undefined>(resolve => {
        session.ways = raw.map((w: VerifyWay) => ({
          way: String(w.verify_way ?? ''),
          mobile: typeof w.mobile === 'string' ? w.mobile : undefined,
          smsContent: typeof w.sms_content === 'string' ? w.sms_content : undefined,
        }))
        session.statusText = '请选择二次验证方式'
        // 60 秒未选择自动走 SDK 内置优先级, 不卡死登录
        const timer = setTimeout(() => {
          if (session.wayWaiter?.resolve === resolve) session.wayWaiter = undefined
          session.ways = undefined
          resolve(undefined)
        }, 60_000)
        session.wayWaiter = { resolve, timer }
      }),
      onMfa: info => new Promise<string>((resolve, reject) => {
        session.phase = 'mfa'
        session.mfaKind = info.kind ?? 'sms'
        session.maskedMobile = info.maskedMobile
        session.statusText = info.kind === 'password'
          ? '触发密码验证'
          : `验证码已发至 ${info.maskedMobile ?? '安全手机'}`
        // 5 分钟未提交验证码自动失败
        const timer = setTimeout(() => {
          if (session.mfaWaiter?.resolve === resolve) session.mfaWaiter = undefined
          reject(new Error(info.kind === 'password' ? '等待密码输入超时' : '等待验证码输入超时'))
        }, 5 * 60_000)
        session.mfaWaiter = { resolve, reject, timer }
      }),
    })
    if (session.cancelled) return
    persist(result)
    session.uid = result.userId
    session.name = String(result.userData?.screen_name ?? '') || accountStore.load(result.userId)?.screenName
    session.phase = 'success'
    logger.info(`[douyin] 扫码登录成功: ${session.name || session.uid}`)
  } catch (err) {
    if (session.cancelled) return
    session.phase = 'error'
    session.error = err instanceof Error ? err.message : String(err)
    logger.warn(`[douyin] 扫码登录失败: ${session.error}`)
  } finally {
    session.mfaWaiter = undefined
    if (session.wayWaiter) {
      clearTimeout(session.wayWaiter.timer)
      session.wayWaiter = undefined
    }
  }
}

/** 发起扫码登录（全局互斥；立即返回会话 id，状态由 pollDouyinLogin 轮询） */
export const startDouyinLogin = (): { id: string } | { error: string } => {
  for (const s of sessions.values()) {
    if (ACTIVE_PHASES.has(s.phase)) return { error: '已有抖音登录进行中，请稍候再试' }
  }
  const session: DouyinLoginSession = {
    id: randomUUID(),
    createdAt: Date.now(),
    phase: 'pending',
    statusText: '正在获取二维码',
  }
  sessions.set(session.id, session)
  // 不 await：登录流程后台执行，面板轮询获取进度
  void runLogin(session)
  return { id: session.id }
}

/** 轮询登录状态快照（面板每 2s 调用）；会话不存在/已过期返回 expired */
export const pollDouyinLogin = async (id: string): Promise<DouyinLoginSnapshot> => {
  const session = sessions.get(id)
  if (!session) return { phase: 'expired' }
  if (Date.now() - session.createdAt > SESSION_TTL) {
    sessions.delete(id)
    return { phase: 'expired' }
  }
  return {
    phase: session.phase,
    image: session.image,
    statusText: session.statusText,
    mfaKind: session.mfaKind,
    maskedMobile: session.maskedMobile,
    ways: session.ways,
    verifyUrl: session.verifyUrl,
    uid: session.uid,
    name: session.name,
    error: session.error,
  }
}

/** 提交扫码二次验证输入（短信验证码或密码）；无等待中的验证返回 false */
export const submitDouyinMfa = (id: string, code: string): boolean => {
  const waiter = sessions.get(id)?.mfaWaiter
  if (!waiter) return false
  clearTimeout(waiter.timer)
  sessions.get(id)!.mfaWaiter = undefined
  waiter.resolve(code)
  return true
}

/** 选择二次验证方式（way 空 = 使用 SDK 默认优先级）；无待选择返回 false */
export const selectDouyinVerifyWay = (id: string, way?: string): boolean => {
  const session = sessions.get(id)
  const waiter = session?.wayWaiter
  if (!session || !waiter) return false
  clearTimeout(waiter.timer)
  session.wayWaiter = undefined
  session.ways = undefined
  waiter.resolve(way || undefined)
  return true
}

/** 取消扫码登录会话 */
export const cancelDouyinLogin = (id: string): boolean => {
  const session = sessions.get(id)
  if (!session) return false
  session.cancelled = true
  session.mfaWaiter?.reject(new Error('登录已取消'))
  session.wayWaiter?.resolve(undefined)
  return sessions.delete(id)
}
