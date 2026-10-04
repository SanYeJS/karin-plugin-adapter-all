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
 * NapCat 适配器 (OneBot11)
 * 能力三层:
 *  1. OneBot11 标准 API     → 全量支持 (base 已实现)
 *  2. go-cqhttp 兼容层      → 群管/文件/凭据等 (de facto 标准)
 *  3. NapCat 专有 DLC(PacketBackend) → Rkey / MarkDown / AI声聊 / 小程序卡片
 *
 * 已封装高价值扩展 (P1):
 *  - 凭证/签名: getRkey / getClientKey
 *  - AI声聊:    getAiCharacterList / sendGroupAiRecord / getAiRecord
 *  - 互动/已读: friendPoke / groupPoke / setMsgEmojiLike(群表情回应) /
 *               markMsgAsRead / fetchEmojiLike
 *  - 状态/资料: getOnlineClients / setOnlineStatus / setQqAvatar / setGroupNote
 *  - 消息工具:  getFriendMsgHistory / forwardSingleMsg / translateEn2zh /
 *               ocrImage / checkUrlSafely / getFile / sendGroupSign /
 *               sendGroupNotice / getGroupNotice
 * 其余低频扩展可用 sendApi(action, params) 直通
 *  (如 nc_get_packet_status / nc_upload_file_rich_media / get_group_system_msg)
 */
/** 身份识别关键字 (app_name 匹配用) */
const implKeys = ['napcat']

export class NapCatBot extends OneBot11BaseBot<OneBot11Transport> {
  constructor (cfg: BotConfig) {
    super(cfg)
    this.raw = this.super = createOneBot11Transport(cfg)
    this.adapter.name = 'NapCat'
    this.adapter.version = ''
    this.adapter.protocol = 'napcat'
    this.events()
  }

  /** 执行 OneBot11 action (走通用 WS 客户端) */
  protected call (action: string, params?: any) {
    return this.raw.call(action, params)
  }

  // ===== NapCat 扩展: 凭证 / 签名 =====
  /** 获取 Rkey (NapCat 专有, 小程序/签到等签名场景需用) */
  async getRkey () {
    return (await this.call('nc_get_rkey'))?.data
  }
  /** 获取 ClientKey (NapCat 专有) */
  async getClientKey () {
    return (await this.call('nc_get_client_key'))?.data
  }

  // ===== NapCat 扩展: AI 语音声色 =====
  /** 获取 AI 声色角色列表 (chatType: group / friend; 基类无参版本不适用) */
  async getAiCharacterList (chatType: 'group' | 'friend', chatId: string | number) {
    return this.call('get_ai_characters', { chat_type: chatType, chat_id: +chatId })
  }
  /** 发送 AI 语音 (群聊) */
  async sendGroupAiRecord (groupId: string, characterId: string, text: string, recordType = 1) {
    await this.call('send_group_ai_record', { group_id: +groupId, character_id: characterId, text, record_type: recordType })
  }
  /** 获取 AI 语音记录 */
  async getAiRecord (groupId: string, chatId: string | number, characterId: string, text: string) {
    return this.call('get_ai_record', { group_id: +groupId, chat_id: +chatId, character_id: characterId, text })
  }

  // ===== NapCat 扩展: 互动 · 已读 =====
  /** 私聊戳一戳 (napcat 专有 action) */
  async friendPoke (targetId: string, count = 1) {
    for (let i = 0; i < count; i++) await this.call('friend_poke', { user_id: +targetId })
  }
  /** 群内戳一戳 (napcat 专有 action) */
  async groupPoke (groupId: string, targetId: string, count = 1) {
    for (let i = 0; i < count; i++) await this.call('group_poke', { group_id: +groupId, user_id: +targetId })
  }
  /** 群表情回应 (一次可设置多个表情) */
  async setMsgEmojiLike (messageId: string, emojiIds: Array<number | string>, set = true) {
    await this.call('nc_set_msg_emoji_like', { message_id: +messageId, emoji_ids: emojiIds.map(Number), set })
  }
  /** 标记消息已读 */
  async markMsgAsRead (contact: Contact, messageId: string) {
    return contact.scene === 'group'
      ? this.call('mark_group_msg_as_read', { group_id: +contact.peer, message_id: +messageId })
      : this.call('mark_private_msg_as_read', { user_id: +(contact.scene === 'groupTemp' ? contact.subPeer : contact.peer), message_id: +messageId })
  }
  /** 查看消息的表情回应列表 */
  async fetchEmojiLike (messageId: string, emojiId?: number | string) {
    return this.call('fetch_emoji_like', { message_id: +messageId, ...(emojiId != null ? { emoji_id: +emojiId } : {}) })
  }

  // ===== NapCat 扩展: 在线状态 · 资料 =====
  /** 获取当前账号在线客户端列表 */
  async getOnlineClients () {
    return this.call('nc_get_online_client')
  }
  /** 设置在线状态 (0 在线 / 10 离开 / 11 忙碌 / 12 请勿打扰 / 跟状态码走) */
  async setOnlineStatus (status: number, extStatus?: number, batteryStatus?: number) {
    await this.call('nc_set_online_status', {
      status,
      ...(extStatus != null ? { ext_status: extStatus } : {}),
      ...(batteryStatus != null ? { battery_status: batteryStatus } : {}),
    })
  }
  /** 设置 QQ 头像 (file 可为本地路径 / base64 / URL) */
  async setQqAvatar (file: string) {
    await this.call('set_qq_avatar', { file })
  }
  /** 设置群公告 (markdown 文本) */
  async setGroupNote (groupId: string, note: string) {
    await this.call('set_group_note', { group_id: +groupId, note })
  }

  // ===== NapCat 扩展: 消息工具 =====
  /** 获取与好友的历史消息 (分页可逆序) */
  async getFriendMsgHistory (userId: string, startSeq: number | string, count = 20, reverseOrder = false) {
    return this.call('get_friend_msg_history', { user_id: +userId, message_seq: +startSeq, count, reverse_order: reverseOrder })
  }
  /** 单条转发 (好友 / 群) */
  async forwardSingleMsg (contact: Contact, messageId: string) {
    return contact.scene === 'group'
      ? this.call('forward_group_single_msg', { group_id: +contact.peer, message_id: +messageId })
      : this.call('forward_friend_single_msg', { user_id: +(contact.scene === 'groupTemp' ? contact.subPeer : contact.peer), message_id: +messageId })
  }
  /** 英文 → 中文翻译 */
  async translateEn2zh (rawText: string) {
    const r: any = await this.call('translate_en2zh', { raw_text: rawText })
    return r?.messages?.[0]?.message?.[0]?.data?.text ?? ''
  }
  /** OCR 图片识别 */
  async ocrImage (image: string) {
    return this.call('ocr_image', { image })
  }
  /** URL 安全检查 */
  async checkUrlSafely (url: string) {
    return this.call('check_url_safely', { url })
  }
  /** 获取文件信息 */
  async getFile (fileId: string, fileType?: number) {
    return this.call('get_file', { file_id: fileId, ...(fileType != null ? { file_type: fileType } : {}) })
  }
  /** 发送群打卡 */
  async sendGroupSign (groupId: string) {
    await this.call('send_group_sign', { group_id: +groupId })
  }
  /** 发送群公告 */
  async sendGroupNotice (groupId: string, content: string, image?: string) {
    await this.call('_send_group_notice', { group_id: +groupId, content, image })
  }
  /** 获取群公告 */
  async getGroupNotice (groupId: string) {
    return this.call('_get_group_notice', { group_id: +groupId })
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
    await this.verifyImpl(this.cfg.impl ?? 'napcat', implKeys)
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
        this.probeAndRegister().catch((e) => logger.warn(`[NapCat] 协议端接入后注册失败: ${e?.message || e}`))
        return
      }
      // 仅当身份校验通过(verified)后才注册: 防止误配 bot 被 WS 自动重连后幽灵注册
      if (this.verified) this.register()
      this.adapter.connectTime = Date.now()
      logger.bot('info', this.selfId, `[NapCat] 连接成功: ${this.adapter.address}`)
    })
    raw.on('close', () => this.unregister())
    raw.on('error', (e: any) => logger.warn(`[NapCat] 连接错误: ${e?.message || e}`))
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
        logger.warn(`[NapCat] 等待协议端连接超时: ${this.adapter.address}, 保持监听等待接入`)
        return
      }
      return // 身份探测/注册已由 open 事件完成
    }
    await this.probeAndRegister()
  }
}