import { randomUUID } from 'node:crypto'
import QRCode from 'qrcode'
import { WechatClient } from './client'
import type { QRCodeStatus } from './types'

/**
 * Web 面板扫码登录会话管理:
 * 前端调 startWxocQr 拿二维码图片(Web 展示) → 微信扫码 → 前端按间隔轮询 pollWxocQr →
 * scanned 后拿到 bot_token / ilink_bot_id / ilink_user_id, 回填配置表单保存即可绑定。
 */

/** 进行中的扫码会话 */
export interface WxocQrSession {
  id: string
  /** iLink 二维码内容串 */
  qrcode: string
  /** 登录前专用客户端 (无 token, 使用默认 API 地址) */
  client: WechatClient
  createdAt: number
  /** 扫码确认后的登录凭证 (缓存避免重复轮询) */
  result?: {
    token: string
    accountId: string
    userId: string
    nickname?: string
    baseUrl?: string
  }
  /** 二维码已过期 */
  expired?: boolean
}

/** 进行中的扫码会话表 */
const sessions = new Map<string, WxocQrSession>()

const SESSION_TTL = 15 * 60 * 1000
/** 定时清理过期会话 */
setInterval(() => {
  const now = Date.now()
  for (const [id, s] of sessions) {
    if (now - s.createdAt > SESSION_TTL) sessions.delete(id)
  }
}, 60 * 1000).unref?.()

/** 创建扫码会话 返回面板所需信息 { id, image } (image 为二维码 dataURL) */
export const startWxocQr = async (): Promise<{ id: string; image: string }> => {
  // 同时只允许一个进行中会话 创建新的直接作废旧会话
  for (const id of [...sessions.keys()]) sessions.delete(id)

  const client = new WechatClient()
  const qr = await client.getQRCode()
  if (!qr?.qrcode || !qr?.qrcode_img_content) throw new Error('获取二维码失败')

  // qrcode_img_content 是待编码的链接串 (非图片) 本地渲染为二维码
  const image = await QRCode.toDataURL(qr.qrcode_img_content, { width: 280, margin: 2 })

  const session: WxocQrSession = { id: randomUUID(), qrcode: qr.qrcode, client, createdAt: Date.now() }
  sessions.set(session.id, session)
  return { id: session.id, image }
}

/** 查询扫码状态 (每次调用轮询一次后台接口, confirmed 后缓存凭证) */
export const pollWxocQr = async (id: string): Promise<{
  phase: 'pending' | 'scanned' | 'expired'
  token?: string
  accountId?: string
  userId?: string
  nickname?: string
  baseUrl?: string
}> => {
  const session = sessions.get(id)
  if (!session) return { phase: 'expired' }
  if (session.result) return { phase: 'scanned', ...session.result }
  if (session.expired) return { phase: 'expired' }

  const status: QRCodeStatus = await session.client.pollQRStatus(session.qrcode)
  if (status.status === 'expired') {
    session.expired = true
    return { phase: 'expired' }
  }
  if (status.status === 'confirmed' && status.bot_token && status.ilink_user_id) {
    session.result = {
      token: status.bot_token,
      accountId: status.ilink_bot_id || '',
      userId: status.ilink_user_id,
      nickname: status.nickname,
      baseUrl: status.baseurl,
    }
    return { phase: 'scanned', ...session.result }
  }
  return { phase: 'pending' }
}

/** 取消扫码会话 */
export const cancelWxocQr = (id: string): boolean => sessions.delete(id)
