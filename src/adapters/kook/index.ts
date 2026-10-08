import { logger, type Contact, type Elements, type GroupInfo, type GroupMemberInfo, type MessageResponse, type SendElement, type SendMsgResults, type UserInfo } from 'node-karin'
import { BaseBot } from '../base'
import type { BotConfig } from '../base'
import { Client } from './client'
import { createKookEventChannel, type KookEventChannel } from './eventChannel'
import { AdapterConvertKarin, parseKookContent, KarinConvertAdapter, buildCard, type KookConvertResult } from './convert'
import { EventDispatch } from './event'

const PACKAGE_VERSION = '1.0.0'

/** KMarkdown 文本按 8000 字符拆条, 优先在换行处切分 (避免切断 URL / (met) / ![图] 语法) */
function splitKmarkdown (content: string, max: number): string[] {
  if (content.length <= max) return [content]
  const parts: string[] = []
  let rest = content
  while (rest.length > max) {
    const chunk = rest.slice(0, max)
    const nl = chunk.lastIndexOf('\n')
    const cut = nl > 0 ? nl + 1 : max
    parts.push(rest.slice(0, cut))
    rest = rest.slice(cut)
  }
  if (rest.length > 0) parts.push(rest)
  return parts
}

/**
 * Kook (开黑啦) 协议适配器:
 * 官方 API 直连 (https://www.kookapp.cn/api/v3, Authorization: Bot <token>)。
 * 事件接收: ws(官方 Gateway) / webhook(本端 HTTP) 双模式。
 */
export class KookBot extends BaseBot {
  /** Kook API 客户端 */
  super: Client
  /** 事件接收通道 (stop 时关闭) */
  raw: KookEventChannel
  /** 是否已初始化(拉取机器人信息) */
  #inited = false
  /** 是否已主动停止(停止后不再自动重连) */
  #stopped = false

  constructor (cfg: BotConfig) {
    super(cfg)
    this.super = new Client(cfg)
    this.raw = createKookEventChannel(cfg)
    this.adapter.name = 'Kook'
    this.adapter.version = PACKAGE_VERSION
    this.adapter.platform = 'koko'
    this.adapter.standard = 'kook'
    this.adapter.protocol = 'kook'
    // ws→官方 Gateway 客户端 / webhook→本端 HTTP 服务接收回调
    this.adapter.communication = this.raw.mode === 'webhook' ? 'http' : 'webSocketClient'
    this.adapter.address = this.raw.address
  }

  /** 注册 Bot (连接建立/WebHook启动后调用) */
  __registerBot () {
    this.register()
  }

  /** 注销 Bot (断开时调用) */
  __unregisterBot () {
    this.unregister()
  }

  /** 打印当前 Bot 专属日志 */
  logger (level: 'info' | 'error' | 'trace' | 'debug' | 'mark' | 'warn' | 'fatal', ...args: any[]) {
    logger.bot(level, this.account.selfId, ...args)
  }

  /** 直通 Kook API */
  async sendApi (path: string, data?: any) {
    return this.super.request(path, data)
  }

  /** 初始化: 拉取机器人信息 */
  async #init () {
    if (this.#inited) return
    const info = await this.super.me()
    if (!info?.id) throw new Error('获取机器人信息失败: 请检查 kookToken')
    const selfId = String(info.id)
    this.account = {
      uin: selfId,
      uid: selfId,
      selfId,
      name: info.nickname || info.username || selfId,
      avatar: info.avatar || '',
      subId: {},
    }
    this.#inited = true
    return true
  }

  /** 连接建立 */
  #onOpen () {
    this.__registerBot()
  }

  /** 收到事件 */
  #onEvent (event: any) {
    try {
      EventDispatch(event, this)
    } catch (err: any) {
      this.logger('error', `事件处理错误: ${err.message}`)
    }
  }

  /** 连接断开 */
  #onClose () {
    this.__unregisterBot()
  }

  /** 启动: 初始化 + 建立事件接收 */
  async start () {
    if (this.raw.isConnected) return
    if (this.#stopped) this.#stopped = false
    await this.#init()
    const handlers = {
      onOpen: () => this.#onOpen(),
      onMessage: (event: any) => this.#onEvent(event),
      onError: (err: Error) => this.logger('error', `事件连接错误: ${err.message}`),
      onClose: () => this.#onClose(),
      onReconnect: async () => {
        const gateway = await this.super.getGateway()
        return gateway?.url
      },
    }
    if (this.raw.mode === 'ws' && 'start' in this.raw) {
      // 先获取官方 Gateway 地址 (含鉴权 token)
      const gateway = await this.super.getGateway()
      if (!gateway?.url) throw new Error('获取 Kook Gateway 地址失败')
      this.adapter.address = gateway.url
      this.raw.start(handlers, gateway.url)
    } else {
      this.raw.start(handlers)
    }
  }

  /** 停止 */
  async stop () {
    this.#stopped = true
    this.raw.stop()
    this.#onClose()
  }

  // ===== 消息 =====
  /** Kook 单条消息 content 建议不超过 8000 字符 (官方接口文档约束), 超长自动拆条 */
  static readonly MAX_CONTENT_LENGTH = 8000

  /** 媒体上传回调 (Kook content 中的媒体 src 必须为 http URL) */
  #upload = (src: string, kind: 'image' | 'file' | 'audio') => this.super.uploadAsset(src, kind)

  /**
   * 转换结果 → 发送。
   * type=9 KMarkdown 文本超长时按换行拆条, 首条携带引用;
   * type=10 卡片消息整卡一次发送 (媒体已在转换时上传为 URL, 不会超长)。
   */
  async #sendConverted (
    targetId: string,
    converted: KookConvertResult,
    sender: (content: string, type: number, quote?: string) => Promise<any>
  ): Promise<SendMsgResults> {
    const MAX = KookBot.MAX_CONTENT_LENGTH
    const toResult = (r: any): SendMsgResults => ({
      messageId: r.msg_id,
      time: Math.floor((r.msg_timestamp || Date.now()) / 1000),
      rawData: r,
      message_id: r.msg_id,
      messageTime: Math.floor((r.msg_timestamp || Date.now()) / 1000),
    })
    // 卡片消息: 整卡一次发送
    if (converted.type === 10 && converted.card) {
      return toResult(await sender(JSON.stringify([converted.card]), 10, converted.quote))
    }
    // 原生媒体消息 (type=2/3/4/5): content 为单个资源 URL, 一次发送
    if (converted.type === 2 || converted.type === 3 || converted.type === 4 || converted.type === 5) {
      return toResult(await sender(converted.content, converted.type, converted.quote))
    }
    // KMarkdown 文本消息 (type=9): 超过 8000 字符时按换行拆条
    const chunks = splitKmarkdown(converted.content, MAX)
    let first: SendMsgResults | undefined
    for (let i = 0; i < chunks.length; i++) {
      const r = await sender(chunks[i], 9, i === 0 ? converted.quote : undefined)
      if (first === undefined) first = toResult(r)
    }
    return first as SendMsgResults
  }

  async sendMsg (contact: Contact, elements: Array<SendElement>): Promise<SendMsgResults> {
    const converted = await KarinConvertAdapter(elements, this.#upload)
    // 频道消息: target_id=子频道ID(subPeer), 走 /message/create
    if (contact.scene === 'guild') {
      const targetId = contact.subPeer
      return this.#sendConverted(targetId, converted, (content, type, quote) =>
        this.super.createMessage(targetId, content, quote, type)
      )
    }
    // 私信: target_id=对端用户ID(peer), 必须走 /direct-message/create (频道消息接口不认用户ID)
    if (contact.scene === 'direct') {
      const targetId = contact.peer
      if (!targetId) throw new Error('缺少私信目标用户ID')
      return this.#sendConverted(targetId, converted, (content, type, quote) =>
        this.super.directCreate(targetId, content, quote, undefined, type)
      )
    }
    throw new Error(`Kook 不支持的消息场景: ${contact.scene}`)
  }

  async recallMsg (_contact: Contact, messageId: string): Promise<void> {
    await this.super.deleteMessage(messageId)
  }

  /** 编辑消息(仅频道内自己发送的消息) 返回新的消息ID/时间戳 */
  async editMsg (_contact: Contact, messageId: string, elements: Array<SendElement>): Promise<SendMsgResults> {
    const converted = await KarinConvertAdapter(elements, this.#upload)
    const toResult = (r: any): SendMsgResults => ({
      messageId: r.msg_id,
      time: Math.floor((r.msg_timestamp || Date.now()) / 1000),
      rawData: r,
      message_id: r.msg_id,
      messageTime: Math.floor((r.msg_timestamp || Date.now()) / 1000),
    })
    // 官方 /message/update 仅支持 type=9/10, 原生媒体 (2/3/4/5) 需转成卡片编辑
    let contentType = converted.type
    let content = converted.content
    let card = converted.card
    if (contentType !== 9 && contentType !== 10) {
      card = contentType === 2
        ? buildCard([], [converted.content], [])
        : contentType === 3
          ? buildCard([], [], [{ type: 'video', src: converted.content }])
          : contentType === 4
            ? buildCard([], [], [{ type: 'file', src: converted.content }])
            : buildCard([], [], [{ type: 'audio', src: converted.content }])
      contentType = 10
      content = ''
    }
    const updateContent = contentType === 10 ? JSON.stringify([card]) : content
    const res = await this.super.updateMessage(messageId, updateContent, converted.quote, contentType === 10 ? 10 : 9)
    return toResult(res)
  }

  /** 消息表情回应 (emoji 为 Kook 表情符号或对应 ID) */
  async reactMsg (_messageId: string, emoji: string, remove = false): Promise<void> {
    if (remove) await this.super.deleteReaction(_messageId, emoji)
    else await this.super.addReaction(_messageId, emoji)
  }

  /** 框架标准表情回应: faceId 即 Kook 表情写法/ID */
  async setMsgReaction (_contact: Contact, messageId: string, faceId: number | string, isSet: boolean): Promise<void> {
    const emoji = String(faceId)
    if (isSet) await this.super.addReaction(messageId, emoji)
    else await this.super.deleteReaction(messageId, emoji)
  }

  /** 私信直发: 以用户 ID 为目标发送私信 (无需先有私信会话) */
  async sendPrivateMsg (targetUserId: string, elements: Array<SendElement>): Promise<SendMsgResults> {
    const converted = await KarinConvertAdapter(elements, this.#upload)
    return this.#sendConverted(targetUserId, converted, (content, type, quote) =>
      this.super.directCreate(targetUserId, content, quote, undefined, type)
    )
  }

  /** Kook 消息结构 → Karin MessageResponse (共享逻辑) */
  #msgToResponse (msg: any): MessageResponse {
    const messageId = String(msg.msg_id)
    const isDirect = msg.channel_type === 'PERSON'
    const author = msg.extra?.author || {}
    const userId = String(msg.author_id)
    const name = author.nickname || author.username || userId
    const targetId = String(msg.target_id || '')
    const guildId = String(msg.extra?.guild_id || msg.guild_id || '')
    // 私信: peer=对端用户ID(发信人/回复目标), subPeer=机器人ID, 与事件私信 contact 语义一致
    const contact = isDirect
      ? { scene: 'direct' as const, peer: userId, subPeer: targetId || userId, name, subName: String(msg.extra?.channel_name || '') }
      : { scene: 'guild' as const, peer: guildId || targetId, subPeer: targetId, name: String(msg.extra?.guild_name || ''), subName: String(msg.extra?.channel_name || '') }
    const sender = {
      userId,
      nick: name,
      name,
      role: isDirect ? 'unknown' : 'member',
    }
    return {
      time: Math.floor((msg.msg_timestamp || Date.now()) / 1000),
      messageId,
      messageSeq: Number(msg.msg_seq || 0),
      contact: contact as Contact,
      sender: sender as MessageResponse['sender'],
      elements: AdapterConvertKarin(msg.content || ''),
    } as MessageResponse
  }

  async getMsg (_contact: Contact | string, messageId?: string): Promise<MessageResponse> {
    const id = typeof _contact === 'string' ? _contact : messageId
    if (!id) throw new Error('缺少消息ID')
    const msg = await this.super.viewMessage(id)
    return this.#msgToResponse(msg)
  }

  async getHistoryMsg (_contact: Contact, _startMsgSeq: string | number, count: number): Promise<MessageResponse[]> {
    // _startMsgSeq 为消息ID(锚点, 取该消息之前的数据) 或页数(忽略, Kook 用锚点分页)
    const msgId = typeof _startMsgSeq === 'string' && _startMsgSeq ? _startMsgSeq : undefined
    const size = Math.min(100, count)
    const limiter = size > 0 ? Math.max(1, Math.floor(size)) : 1
    let res: { items: Array<Record<string, any>> }
    if (_contact.scene === 'guild') {
      // 频道历史: /message/list 需要子频道ID
      const channelId = _contact.subPeer
      res = await this.super.messageList(channelId, msgId, msgId ? 'before' : undefined, limiter)
    } else {
      // 私信历史: /message/list 不认用户ID, 必须走 /direct-message/list (target_id + msg_id + flag)
      const userId = _contact.peer
      res = await this.super.directMessageList({
        targetId: userId,
        msgId,
        flag: msgId ? 'before' : undefined,
        pageSize: limiter,
      })
    }
    const result: MessageResponse[] = []
    for (const i of res.items || []) {
      result.push(this.#msgToResponse(i))
    }
    return result
  }

  // ===== 查询 =====
  async getAvatarUrl (userId: string, _size?: number): Promise<string> {
    try {
      const user = await this.super.viewUser(userId)
      return user?.avatar || ''
    } catch {
      return ''
    }
  }

  /** 服务器头像 (KookGuild.icon, CDN 链接) */
  async getGroupAvatarUrl (groupId: string, _size?: number, _history?: number): Promise<string> {
    try {
      const guild = await this.super.guildView(groupId)
      return guild?.icon || ''
    } catch {
      return ''
    }
  }

  async getStrangerInfo (targetId: string): Promise<UserInfo> {
    const user = await this.super.viewUser(targetId)
    return {
      userId: String(user.id),
      nick: user.nickname || user.username || String(user.id),
      name: user.nickname || user.username || String(user.id),
    } as UserInfo
  }

  async getGroupInfo (groupId: string, _noCache?: boolean): Promise<GroupInfo> {
    const guild = await this.super.guildView(groupId)
    // 成员数: 取成员列表接口的 total (每页1条仅拿计数)
    const memberCount = await this.super.guildUserList(groupId, 1, 1)
      .then(r => r.meta?.total || 0)
      .catch(() => 0)
    // 管理员: role-list 中 is_admin/is_owner 角色下的成员去重
    const admins: GroupInfo['admins'] = []
    try {
      const roles = await this.super.guildRoleList(groupId)
      for (const r of roles || []) {
        if (r?.is_admin || r?.is_owner) {
          for (const id of (r?.user_ids as string[] | undefined) || []) {
            const userId = String(id)
            admins.push({ userId, name: userId, role: 'admin' })
          }
        }
      }
    } catch { /* 角色信息获取失败不阻塞 */ }
    return {
      groupId: String(guild.id),
      groupName: guild.name,
      memberCount,
      maxMemberCount: 0,
      admins: admins.filter((a, i, arr) => arr.findIndex(x => x.userId === a.userId) === i),
      avatar: guild.icon || '',
    } as GroupInfo
  }

  async getGroupList (_refresh?: boolean): Promise<Array<GroupInfo>> {
    const res = await this.super.guildList()
    const groups: GroupInfo[] = []
    for (const i of res.items || []) {
      groups.push({
        groupId: String(i.id),
        groupName: i.name,
        memberCount: 0,
        maxMemberCount: 0,
        admins: [],
        avatar: i.icon || '',
      } as GroupInfo)
    }
    return groups
  }

  /** 服务器成员 → 群成员信息 (guild/user-list 无角色字段, 全部按 member; 自动翻页取全量) */
  async getGroupMemberList (groupId: string, _refresh?: boolean): Promise<Array<GroupMemberInfo>> {
    const info: GroupMemberInfo[] = []
    const PAGE_SIZE = 100
    let page = 1
    let total = Infinity
    // guild/user-list 分页返回, 循环取到底; 上限 500 页防止异常死循环
    while (info.length < total && page <= 500) {
      const res = await this.super.guildUserList(groupId, page, PAGE_SIZE)
      total = res.meta?.total ?? info.length
      const items = res.items || []
      for (const u of items) {
        const userId = String(u.id)
        const name = u.nickname || u.username || userId
        info.push({
          userId,
          role: 'member',
          nick: name,
          name,
          sender: { userId, nick: name, name, role: 'member' },
        } as GroupMemberInfo)
      }
      if (items.length < PAGE_SIZE) break
      page++
    }
    return info
  }

  async getGroupMemberInfo (groupId: string, targetId: string, _refresh?: boolean): Promise<GroupMemberInfo> {
    const user = await this.super.viewUser(targetId, groupId)
    const userId = String(user.id)
    const name = user.nickname || user.username || userId
    return {
      userId,
      role: 'member',
      nick: name,
      name,
      sender: { userId, nick: name, name, role: 'member' },
    } as GroupMemberInfo
  }

  async getFriendList (_refresh?: boolean): Promise<Array<UserInfo>> {
    // Kook 无好友概念
    return []
  }

  // ===== 管理/互动 (框架标准方法对齐) =====
  /** 踢出服务器成员 (Kook /guild/kickout; rejectAddRequest/kickReason 平台无对应参数) */
  async groupKickMember (groupId: string, targetId: string, _rejectAddRequest?: boolean, _kickReason?: string): Promise<void> {
    await this.super.guildKickout(groupId, targetId)
  }

  /** 设置服务器内昵称(群名片): /guild/nickname (card 为空串则清空昵称) */
  async setGroupMemberCard (groupId: string, targetId: string, card: string): Promise<void> {
    await this.super.guildNickname(groupId, card, targetId)
  }

  /** 退出服务器: /guild/leave (Kook 无解散服务器能力) */
  async setGroupQuit (groupId: string, isDismiss: boolean): Promise<void> {
    if (isDismiss) throw new Error('Kook 官方 API 不支持解散服务器')
    await this.super.guildLeave(groupId)
  }

  /**
   * 语音闭麦/解除: Kook 无文字禁言接口, /guild-mute 仅作用语音
   * duration>0 → 麦克风闭麦(生效), duration<=0 → 解除闭麦。
   */
  async setGroupMute (groupId: string, targetId: string, duration: number): Promise<void> {
    await this.super.guildMute(groupId, targetId, 1, duration > 0)
  }

  /** Kook 官方 API 无全员禁言接口 */
  async setGroupAllMute (_groupId: string, _isBan: boolean): Promise<void> {
    throw new Error('Kook 官方 API 不支持全员禁言')
  }

  /** Kook 官方 API 无修改服务器名称接口 */
  async setGroupName (_groupId: string, _groupName: string): Promise<void> {
    throw new Error('Kook 官方 API 不支持修改服务器名称')
  }

  /** Kook 管理员为固定角色, 不支持通过 API 授予/撤销管理员 */
  async setGroupAdmin (_groupId: string, _targetId: string, _isAdmin: boolean): Promise<void> {
    throw new Error('Kook 不支持通过 API 设置管理员')
  }

  /** Kook 无群专属头衔概念 */
  async setGroupMemberTitle (_groupId: string, _targetId: string, _title: string): Promise<void> {
    throw new Error('Kook 不支持设置群专属头衔')
  }
}

/** kook 协议 bot 工厂 */
export const createKookBot = (cfg: BotConfig): KookBot | undefined => {
  return new KookBot(cfg)
}