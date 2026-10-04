import axios from 'node-karin/axios'
import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import QRCode from 'qrcode'

/**
 * QQ 开放平台「扫码绑定机器人」能力 (自研实现, 不依赖官方混淆 npm 包)。
 * 协议还原自 @tencent-connect/qqbot-connector@1.2.0 (UNLICENSED, 底层 HTTP 接口未公开):
 *  - POST {host}/lite/create_bind_task  创建绑定任务, body { key: randomBytes(32).base64 } → data.task_id
 *  - POST {host}/lite/poll_bind_result  轮询结果,      body { task_id } → data.{ status, bot_appid, bot_encrypt_secret, user_openid }
 *  - 二维码内容 = connect.html 链接 (手机 QQ 扫码 → 选择机器人 → 确认绑定)
 *  - bot_encrypt_secret 为 AES-256-GCM 密文: iv[0:12] + data[12:-16] + authTag[-16:], 密钥 = key
 *
 * 流程: 前端调 startQr 拿二维码图片(Web 展示) → 手机 QQ 扫码 → 前端按 2s 轮询 pollQr → scanned 后拿到
 * AppID / AppSecret / userOpenid, 回填配置表单保存即可绑定。
 */

/** 绑定接口域名 (与官方 SDK 一致: 生产 q.qq.com / 测试 test.q.qq.com) */
export const QQ_BIND_HOST = 'https://q.qq.com'

/** 轮询绑定任务的 status 枚举 */
export enum QrBindStatus {
  NONE = 0,
  PENDING = 1,
  COMPLETED = 2,
  EXPIRED = 3,
}

/** 生成绑定密钥 (用于解密 bot_encrypt_secret 的 AES-GCM key, base64) */
export const generateBindKey = (): string => randomBytes(32).toString('base64')

/** 构造二维码链接 (手机 QQ 扫码后打开的绑定确认页) */
export const buildConnectUrl = (taskId: string, source = ''): string =>
  `https://q.qq.com/qqbot/openclaw/connect.html?task_id=${encodeURIComponent(taskId)}&source=${encodeURIComponent(source)}&_wv=2`

/** POST JSON 到绑定接口 (与官方 SDK 一致: 10s 超时, 非 200 抛错) */
async function post<T> (url: string, body: Record<string, unknown>): Promise<T> {
  const res = await axios.post<T>(url, body, {
    timeout: 10000,
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
  })
  return res.data
}

/** 创建绑定任务, 返回 taskId (后续轮询只传 task_id) */
export const createBindTask = async (key: string): Promise<string> => {
  const data = await post<{ retcode: number; msg?: string; data?: { task_id?: string } }>(
    `${QQ_BIND_HOST}/lite/create_bind_task`,
    { key },
  )
  if (data.retcode !== 0) throw new Error(data.msg ?? 'create_bind_task failed')
  if (!data.data?.task_id) throw new Error('create_bind_task: missing task_id')
  return data.data.task_id
}

/** 轮询绑定结果 */
export const pollBindResult = async (taskId: string): Promise<{
  status: QrBindStatus
  botAppId: string
  botEncryptSecret: string
  userOpenid?: string
}> => {
  const data = await post<{ retcode: number; msg?: string; data?: { status?: number; bot_appid?: string; bot_encrypt_secret?: string; user_openid?: string } }>(
    `${QQ_BIND_HOST}/lite/poll_bind_result`,
    { task_id: taskId },
  )
  if (data.retcode !== 0) throw new Error(data.msg ?? 'poll_bind_result failed')
  const d = data.data ?? {}
  return {
    status: (d.status ?? QrBindStatus.NONE) as QrBindStatus,
    botAppId: String(d.bot_appid ?? ''),
    botEncryptSecret: d.bot_encrypt_secret ?? '',
    userOpenid: d.user_openid || undefined,
  }
}

/**
 * 解密绑定任务回传的 bot_encrypt_secret → AppSecret (明文 utf8)
 * 密文结构: iv(12B) + ciphertext + authTag(16B), AES-256-GCM
 */
export const decryptSecret = (encrypted: string, key: string): string => {
  const data = Buffer.from(encrypted, 'base64')
  const keyBuf = Buffer.from(key, 'base64')
  const iv = data.subarray(0, 12)
  const tag = data.subarray(data.length - 16)
  const cipher = data.subarray(12, data.length - 16)
  const decipher = createDecipheriv('aes-256-gcm', keyBuf, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(cipher), decipher.final()]).toString('utf8')
}

/* ==================== 会话管理 (Web 面板每 2s 轮询) ==================== */

export interface QrSession {
  id: string
  taskId: string
  key: string
  url: string
  createdAt: number
  /** 扫码成功后的凭证 (缓存在会话内, 重复轮询不再请求接口) */
  result?: { appId: string; appSecret: string; userOpenid?: string }
  /** 二维码已过期 */
  expired?: boolean
}

/** 进行中的扫码会话表 */
const sessions = new Map<string, QrSession>()

const SESSION_TTL = 15 * 60 * 1000
/** 定时清理过期会话 */
setInterval(() => {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL) sessions.delete(id)
  }
}, 60 * 1000).unref?.()

/** 创建扫码会话, 返回面板所需信息 { id, url, image } (image 为二维码 PNG dataURL) */
export const startQr = async (source = ''): Promise<{ id: string; url: string; image: string }> => {
  const key = generateBindKey()
  const taskId = await createBindTask(key)
  const url = buildConnectUrl(taskId, source)
  const image = await QRCode.toDataURL(url, {
    width: 280,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#ffffff' },
  })
  const session: QrSession = { id: randomUUID(), taskId, key, url, createdAt: Date.now() }
  sessions.set(session.id, session)
  return { id: session.id, url, image }
}

/** 查询扫码状态 (每次调用轮询一次后台接口, scanned 后缓存结果) */
export const pollQr = async (id: string): Promise<{
  phase: 'pending' | 'expired' | 'scanned'
  appId?: string
  appSecret?: string
  userOpenid?: string
}> => {
  const session = sessions.get(id)
  if (!session) return { phase: 'expired' }
  if (session.result) return { phase: 'scanned', ...session.result }
  if (session.expired) return { phase: 'expired' }
  const res = await pollBindResult(session.taskId)
  if (res.status === QrBindStatus.COMPLETED) {
    const appSecret = decryptSecret(res.botEncryptSecret, session.key)
    session.result = { appId: res.botAppId, appSecret, userOpenid: res.userOpenid }
    return { phase: 'scanned', ...session.result }
  }
  if (res.status === QrBindStatus.EXPIRED) {
    session.expired = true
    return { phase: 'expired' }
  }
  return { phase: 'pending' }
}

/** 取消扫码会话 */
export const cancelQr = (id: string): boolean => sessions.delete(id)