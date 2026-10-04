import {
  OneBotCreateMessage,
  OneBotCreateNotice,
  OneBotCreateRequest,
  logger,
} from 'node-karin'
import type { Contact } from 'node-karin'
import { createOneBot11Transport, type OneBot11Transport } from './transport'
import { OneBot11BaseBot } from './base'
import type { BotConfig } from '../base'

/**
 * Lagrange 适配器 (OneBot11)
 * 扩展相对克制: 标准 API 全量 (base 已实现)
 * 特色: Markdown 消息段 / 按钮(button) 消息段 + poke / forward / emoji_like
 * 不支持: Rkey / clientkey / AI语音 / translate → 无需适配
 *
 * 已封装特色扩展 (P1):
 *  - markdown{template_id,params} / button{id,text,data,callback_data} 消息段
 *    → makeMarkdownSegment / sendMarkdownMsg / makeButtonSegment / sendButtonMsg
 *  - uploadImage (上传图片返回 URL)
 *  - getAiCharacterList (需带 group_id / chat_type)
 *  - getGroupMsgHistory (reverse_order 逆序分页增强)
 *
 * 消息段转换注意事项:
 *  - markdown / button 属 Lagrange 独有, 未在 node-karin 转换器中,
 *    收到时需自行转为 Karin 元素 (后续按需补充)
 *  - poke / set_msg_emoji_like(一人多条) / get_msg / delete_msg 走标准 action
 */
/** 身份识别关键字 (app_name 匹配用) */
const implKeys = ['lagrange']

export class LagrangeBot extends OneBot11BaseBot<OneBot11Transport> {
  constructor (cfg: BotConfig) {
    super(cfg)
    this.raw = this.super = createOneBot11Transport(cfg)
    this.adapter.name = 'Lagrange'
    this.adapter.version = ''
    this.adapter.protocol = 'lagrange'
    this.events()
  }

  /** 执行 OneBot11 action (走通用 WS 客户端) */
  protected call (action: string, params?: any) {
    return this.raw.call(action, params)
  }

  // ===== Lagrange 特色: Markdown 消息段 =====
  /** 构造 markdown 消息段 (需在 Lagrange 后台申请模板与接口权限) */
  makeMarkdownSegment (templateId: string | number, params?: Record<string, string>) {
    return { type: 'markdown', data: { template_id: String(templateId), params: params ?? {} } }
  }
  /** 发送 markdown 消息 */
  async sendMarkdownMsg (contact: Contact, templateId: string | number, params?: Record<string, string>) {
    const base = contact.scene === 'group'
      ? { group_id: +contact.peer }
      : { user_id: +(contact.scene === 'groupTemp' ? contact.subPeer : contact.peer) }
    return this.call('send_msg', {
      message_type: contact.scene === 'group' ? 'group' : 'private',
      ...base,
      message: [this.makeMarkdownSegment(templateId, params)],
    })
  }

  // ===== Lagrange 特色: 按钮(button) 消息段 =====
  /** 构造 button 消息段 (可附带回传数据) */
  makeButtonSegment (id: string, text: string, data?: string, callbackData?: string) {
    return { type: 'button', data: { id, text, data: data ?? '', callback_data: callbackData ?? '', action: 0, type: 0, visited: false } }
  }
  /** 发送文本 + 按钮消息 */
  async sendButtonMsg (contact: Contact, content: string, buttons: Array<{ id: string; text: string; data?: string; callbackData?: string }>) {
    const base = contact.scene === 'group'
      ? { group_id: +contact.peer }
      : { user_id: +(contact.scene === 'groupTemp' ? contact.subPeer : contact.peer) }
    const message: any[] = [{ type: 'text', data: { text: content } }]
    for (const b of buttons) message.push(this.makeButtonSegment(b.id, b.text, b.data, b.callbackData))
    return this.call('send_msg', {
      message_type: contact.scene === 'group' ? 'group' : 'private',
      ...base,
      message,
    })
  }

  // ===== Lagrange 特色: 其他 =====
  /** 上传图片并返回 URL (Lagrange 专有) */
  async uploadImage (file: string) {
    const r: any = await this.call('upload_image', { file })
    return r?.data?.url ?? r?.url ?? ''
  }
  /** 获取 AI 声色角色列表 (Lagrange 需带群号; 基类无参版本不适用) */
  async getAiCharacterList (groupId: string, chatType: 'group' | 'friend' = 'group') {
    return this.call('get_ai_characters', { group_id: +groupId, chat_type: chatType })
  }
  /** 群历史消息逆序分页 (Lagrange 增强, 支持漏消息追赶) */
  async getGroupMsgHistory (groupId: string, count = 20, reverseOrder = false, startMessageSeq?: number | string) {
    return this.call('get_group_msg_history', {
      group_id: +groupId,
      count,
      reverse_order: reverseOrder,
      ...(startMessageSeq != null ? { message_seq: +startMessageSeq } : {}),
    })
  }

  /** 探测身份并注册 (幂等) */
  private async probeAndRegister () {
    if (this.verified) return this.register()
    // 服务端模式: 监听成功但协议端尚未接入时跳过
    if (!(this.raw as any).isConnected) return
    const login: any = await this.call('get_login_info')
    const selfId = String(login.user_id)
    this.account = {
      uin: selfId,
      uid: selfId,
      selfId,
      name: login.nickname || '',
      avatar: await this.getAvatarUrl(selfId),
      subId: {},
    }
    await this.verifyImpl(this.cfg.impl ?? 'lagrange', implKeys)
    // 身份校验通过后才允许注册(含后续重连恢复)
    this.verified = true
    this.register()
  }

  /** 绑定事件 */
  private events () {
    const raw = this.raw
    raw.on('open', () => {
      if (this.adapter.communication === 'webSocketServer' && !this.verified) {
        // 正向 WS(本端服务端): 协议端接入后自动完成身份探测与注册
        this.probeAndRegister().catch((e) => logger.warn(`[Lagrange] 协议端接入后注册失败: ${e?.message || e}`))
        return
      }
      // 仅当身份校验通过(verified)后才注册: 防止误配 bot 被 WS 自动重连后幽灵注册
      if (this.verified) this.register()
      this.adapter.connectTime = Date.now()
      logger.bot('info', this.selfId, `[Lagrange] 连接成功: ${this.adapter.address}`)
    })
    raw.on('close', () => this.unregister())
    raw.on('error', (e: any) => logger.warn(`[Lagrange] 连接错误: ${e?.message || e}`))
    raw.on('message', (e) => OneBotCreateMessage(e as never, this as never))
    raw.on('notice', (e) => this.handleNotice(e as any, (n) => OneBotCreateNotice(n, this as never)))
    raw.on('request', (e) => OneBotCreateRequest(e as never, this as never))
  }

  /** 启动 */
  async start () {
    if (!this.raw.isConnected) await this.raw.connect()
    if (this.adapter.communication === 'webSocketServer') {
      // 正向 WS(本端服务端): 监听即启动, 等待协议端接入后自动注册
      try {
        await (this.raw as any).waitForClient?.(this.cfg.requestTimeout || 15000)
      } catch {
        logger.warn(`[Lagrange] 等待协议端连接超时: ${this.adapter.address}, 保持监听等待接入`)
        return
      }
      return // 身份探测/注册已由 open 事件完成
    }
    await this.probeAndRegister()
  }
}