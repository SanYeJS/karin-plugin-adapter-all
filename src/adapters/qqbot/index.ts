import { logger, type Contact, type Elements, type GroupInfo, type GroupMemberInfo, type MessageResponse, type SendElement, type SendMsgResults, type UserInfo } from 'node-karin'
import { BaseBot } from '../base'
import type { BotConfig } from '../base'
import { Client } from './client'
import { createQqBotEventChannel, type QqBotEventChannel } from './eventChannel'
import { AdapterConvertKarin, KarinConvertAdapter } from './convert'
import { EventDispatch } from './event'

const PACKAGE_VERSION = '1.0.0'

/**
 * QQ 开放平台(QQBot)协议适配器 (api-v2):
 * 官方 API 直连 (https://api.bot.qq.com, 官方 AccessToken 鉴权 Authorization: QQBot {token})。
 * 事件接收: ws(官方 Gateway) / webhook(本端 HTTP) 双模式。
 * 场景: 频道消息→guild, 频道私信→direct, 群聊→group, 单聊→friend。
 */
export class QqBotBot extends BaseBot {
  /** QQBot API 客户端 */
  super: Client
  /** 事件接收通道 (stop 时关闭) */
  raw: QqBotEventChannel
  /** 是否已初始化(拉取机器人信息) */
  #inited = false
  /** 是否已主动停止(停止后不再自动重连) */
  #stopped = false

  constructor (cfg: BotConfig) {
    super(cfg)
    this.super = new Client(cfg)
    // WS Gateway 登录鉴权凭证由 Client 提供 (官方 AccessToken, Identify 拼 QQBot {token})
    this.raw = createQqBotEventChannel(cfg, () => this.super.getAccessToken())
    this.adapter.name = 'QQBot'
    this.adapter.version = PACKAGE_VERSION
    this.adapter.platform = 'qq'
    this.adapter.standard = 'qqbot'
    this.adapter.protocol = 'qqbot'
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

  /** 直通 QQBot API */
  async sendApi (path: string, data?: any, method: 'get' | 'post' | 'delete' | 'put' = 'post') {
    return this.super.request(method, path, data)
  }

  /** 初始化: 拉取机器人信息 */
  async #init () {
    if (this.#inited) return
    const info = await this.super.me()
    if (!info?.id) throw new Error('获取机器人信息失败: 请检查 qqbotAppId / qqbotClientSecret 是否正确')
    const selfId = String(info.id)
    this.account = {
      uin: selfId,
      uid: selfId,
      selfId,
      name: info.username || selfId,
      avatar: info.avatar || '',
      subId: {},
    }
    this.#inited = true
    return true
  }

  /** 连接建立 */
  #onOpen () {
    this.__registerBot()
    this.logger('info', `连接成功: ${this.adapter.address}`)
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
    }
    if (this.raw.mode === 'ws') {
      // 先获取官方 Gateway 地址 (含鉴权 token)
      const gateway = await this.super.getGateway()
      if (!gateway?.url) throw new Error('获取 QQBot Gateway 地址失败')
      this.adapter.address = gateway.url
        ; (this.raw as any).start(handlers, gateway.url)
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
  async sendMsg (contact: Contact, elements: Array<SendElement>): Promise<SendMsgResults> {
    const result: SendMsgResults = {
      messageId: '',
      time: 0,
      rawData: {},
      message_id: '',
      messageTime: 0,
    }
    const { content, medias, msgId } = await KarinConvertAdapter(elements)
    // 场景分发: 频道/私信走频道消息协议, 群聊/单聊走 v2 协议 (富媒体 msg_type=7)
    let upload: (url: string, fileType: 1 | 2 | 3 | 4, fileData?: string) => Promise<{ file_info: string }>
    let send: (body: Record<string, any>) => Promise<any>
    let channel = false
    if (contact.scene === 'guild') {
      channel = true
      const c = contact.subPeer
      upload = (u, t, fd) => this.super.postChannelFile(c, u, t, fd)
      send = (b) => this.super.sendChannelMessage(c, b)
    } else if (contact.scene === 'direct') {
      channel = true
      const g = contact.peer
      upload = (u, t, fd) => this.super.postDmsFile(g, u, t, fd)
      send = (b) => this.super.sendDmsMessage(g, b)
    } else if (contact.scene === 'group') {
      const g = contact.peer
      upload = (u, t, fd) => this.super.postGroupFile(g, u, t, fd)
      send = (b) => this.super.sendGroupMessage(g, b)
    } else if (contact.scene === 'friend') {
      const o = contact.peer
      upload = (u, t, fd) => this.super.postC2CFile(o, u, t, fd)
      send = (b) => this.super.sendC2CMessage(o, b)
    } else {
      throw new Error(`QQBot 不支持的消息场景: ${contact.scene}`)
    }
    // 频道/私信不支持语音、文件与本地 base64 素材, 降级为文本占位 (官方媒体能力矩阵)
    let text = content
    const usable: Array<{ url: string; kind: 'image' | 'video' | 'record' | 'file'; fileData?: string }> = []
    for (const m of medias) {
      const unsupported = channel && (m.kind === 'record' || m.kind === 'file' || Boolean(m.fileData))
      if (unsupported) text += m.kind === 'record' ? '[语音]' : m.kind === 'file' ? '[文件]' : '[图片]'
      else usable.push(m)
    }
    // 无可用媒体: 纯文本消息
    if (usable.length === 0) {
      const body: Record<string, any> = { content: text, msg_type: 0 }
      if (msgId) body.msg_id = msgId
      return this.#fillResult(result, await send(body))
    }
    let first: SendMsgResults | undefined
    let textAttached = false
    for (let idx = 0; idx < usable.length; idx++) {
      const m = usable[idx]
      let body: Record<string, any>
      let res: any
      if (channel) {
        // 频道: 图片走新版 image 字段直传 url(平台转存), 视频上传后 msg_type=3; 文本附在首条媒体消息
        if (m.kind === 'image') {
          body = { content: textAttached ? '' : text, image: m.url }
        } else {
          const file = await upload(m.url, 2)
          body = { content: textAttached ? '' : text, msg_type: 3, media: { file_info: file.file_info } }
        }
        textAttached = true
        if (msgId && !first) body.msg_id = msgId
        res = await send(body)
      } else {
        // 群聊/单聊 (v2): 文本先单独发一条, 富媒体逐条 msg_type=7 + media.file_info
        if (idx === 0 && text) {
          const tb: Record<string, any> = { content: text, msg_type: 0 }
          if (msgId) tb.msg_id = msgId
          const tr = await send(tb)
          if (!first) first = this.#fillResult(result, tr)
        }
        const fileType: 1 | 2 | 3 | 4 = m.kind === 'image' ? 1 : m.kind === 'video' ? 2 : m.kind === 'record' ? 3 : 4
        const file = await upload(m.url, fileType, m.fileData)
        body = { msg_type: 7, media: { file_info: file.file_info } }
        if (msgId && !first) body.msg_id = msgId
        res = await send(body)
      }
      if (!first) first = this.#fillResult(result, res)
    }
    return first as SendMsgResults
  }

  /** 填充发送结果 */
  #fillResult (result: SendMsgResults, res: any): SendMsgResults {
    const id = String(res?.id || '')
    result.messageId = id
    result.rawData = res || {}
    result.message_id = id
    if (res?.timestamp) {
      const t = parseFloat(res.timestamp)
      if (!isNaN(t)) {
        result.time = Math.floor(t)
        result.messageTime = Math.floor(t)
      }
    }
    return result
  }

  async recallMsg (contact: Contact, messageId: string): Promise<void> {
    switch (contact.scene) {
      case 'guild':
        await this.super.deleteChannelMessage(contact.subPeer, messageId)
        break
      case 'direct':
        await this.super.deleteDmsMessage(contact.peer, messageId)
        break
      case 'group':
        await this.super.deleteGroupMessage(contact.peer, messageId)
        break
      case 'friend':
        await this.super.deleteC2CMessage(contact.peer, messageId)
        break
      default:
        throw new Error(`QQBot 不支持撤回的场景: ${contact.scene}`)
    }
  }

  /**
   * 消息表情回应 (仅频道消息支持)
   * emoji 约定:
   *  - `z:` 前缀 → 系统表情 type=1 (如 z:14)
   *  - `e:` 前缀 → Emoji 表情 type=2 (如 e:2b50)
   *  - 纯数字 → 系统表情 type=1
   *  - 其他(emoji 字符) → 取其 Unicode 码点作为 type=2
   */
  async reactMsg (contact: Contact, messageId: string, emoji: string, remove = false): Promise<void> {
    if (contact.scene !== 'guild') throw new Error('QQBot 表情回应仅支持频道消息')
    const channelId = contact.subPeer
    let emojiType: 1 | 2
    let emojiId: string
    if (emoji.startsWith('z:')) {
      emojiType = 1
      emojiId = emoji.slice(2)
    } else if (emoji.startsWith('e:')) {
      emojiType = 2
      emojiId = emoji.slice(2)
    } else if (/^\d+$/.test(emoji)) {
      emojiType = 1
      emojiId = emoji
    } else {
      // 单码点 emoji 转 unicode hex; 多码点组合仅取首个
      emojiType = 2
      emojiId = [...emoji][0].codePointAt(0)!.toString(16)
    }
    if (remove) {
      await this.super.deleteReaction(channelId, messageId, emojiType, emojiId)
    } else {
      await this.super.addReaction(channelId, messageId, emojiType, emojiId)
    }
  }

  /** 框架标准表情回应: faceId 为数字(系统表情码)或 emoji 字符串, 复用 reactMsg */
  async setMsgReaction (contact: Contact, messageId: string, faceId: number | string, isSet: boolean): Promise<void> {
    await this.reactMsg(contact, messageId, String(faceId), !isSet)
  }

  /** QQBot 消息结构 → Karin MessageResponse (共享逻辑) */
  #msgToResponse (msg: any): MessageResponse {
    const messageId = String(msg.id)
    const author = msg.author || {}
    let userId = String(author.id || author.member_openid || author.user_openid || '')
    const name = author.username || userId || '未知'
    let contact: Contact
    if (msg.group_openid) {
      // 群聊
      userId = String(author.member_openid || author.user_openid || '')
      contact = { scene: 'group', peer: String(msg.group_openid), name: String(msg.group_name || '') }
    } else if (author.user_openid && !msg.guild_id) {
      // 单聊
      userId = String(author.user_openid)
      contact = { scene: 'friend', peer: userId, name }
    } else if (msg.guild_id && msg.channel_id) {
      // 频道消息
      contact = { scene: 'guild', peer: String(msg.guild_id), subPeer: String(msg.channel_id), name: '', subName: '' }
    } else {
      // 频道私信 (dms)
      contact = { scene: 'direct', peer: String(msg.guild_id), subPeer: String(msg.channel_id || ''), name, subName: String(msg.srcGuildId || '') }
    }
    const sender = {
      userId,
      nick: name,
      name,
      role: 'member',
      avatar: author.avatar || '',
    }
    return {
      time: parseTime(msg.timestamp),
      messageId,
      messageSeq: seqOf(msg),
      contact,
      sender: sender as MessageResponse['sender'],
      elements: AdapterConvertKarin(msg.content, msg),
    } as MessageResponse
  }

  async getMsg (_contact: Contact | string, messageId?: string): Promise<MessageResponse> {
    const id = typeof _contact === 'string' ? _contact : messageId
    if (!id) throw new Error('缺少消息ID')
    let msg: any
    if (_contact && typeof _contact === 'object' && _contact.scene === 'guild') {
      msg = await this.super.getChannelMessage(_contact.subPeer, id)
    } else if (_contact && typeof _contact === 'object' && _contact.scene === 'direct') {
      msg = await this.super.getDmsMessage(_contact.peer, id)
    } else {
      throw new Error('QQBot getMsg 需要携带场景上下文(频道/私信)')
    }
    return this.#msgToResponse(msg)
  }

  async getHistoryMsg (_contact: Contact, _startMsgSeq: string | number, count: number): Promise<MessageResponse[]> {
    const before = typeof _startMsgSeq === 'string' && _startMsgSeq ? _startMsgSeq : undefined
    const limit = Math.min(100, count)
    let res: any
    if (_contact.scene === 'guild') {
      res = await this.super.getChannelMessages(_contact.subPeer, limit, before)
    } else if (_contact.scene === 'direct') {
      res = await this.super.getDmsMessages(_contact.peer, limit, before)
    } else if (_contact.scene === 'group') {
      res = await this.super.getGroupMessages(_contact.peer, limit, before)
    } else if (_contact.scene === 'friend') {
      res = await this.super.getC2CMessages(_contact.peer, limit, before)
    } else {
      throw new Error(`QQBot 不支持的历史消息场景: ${_contact.scene}`)
    }
    const result: MessageResponse[] = []
    for (const i of res?.messages || []) {
      result.push(this.#msgToResponse(i))
    }
    return result
  }

  // ===== 查询 =====
  /** QQ 开放平台用户头像: https://q.qlogo.cn/qqapp/{appid}/{openid}/{size} */
  async getAvatarUrl (userId: string, size = 640): Promise<string> {
    return `https://q.qlogo.cn/qqapp/${this.super.appId}/${userId}/${size}`
  }

  async getStrangerInfo (targetId: string): Promise<UserInfo> {
    try {
      const user = await this.super.viewUser(targetId)
      return {
        userId: String(user.id),
        nick: user.username || String(user.id),
        name: user.username || String(user.id),
        avatar: user.avatar || '',
      } as UserInfo
    } catch {
      return {
        userId: targetId,
        nick: targetId,
        name: targetId,
      } as UserInfo
    }
  }

  async getGroupInfo (groupId: string, _noCache?: boolean): Promise<GroupInfo> {
    try {
      const guild = await this.super.getGuild(groupId)
      return {
        groupId: String(guild.id),
        groupName: guild.name,
        memberCount: guild.member_count || 0,
        maxMemberCount: guild.max_members || 0,
        admins: [],
        avatar: guild.icon || '',
      } as GroupInfo
    } catch {
      return {
        groupId,
        groupName: groupId,
        memberCount: 0,
        maxMemberCount: 0,
        admins: [],
      } as GroupInfo
    }
  }

  async getGroupList (_refresh?: boolean): Promise<Array<GroupInfo>> {
    try {
      const guilds = await this.super.getGuilds()
      const groups: GroupInfo[] = []
      for (const i of guilds || []) {
        groups.push({
          groupId: String(i.id),
          groupName: i.name,
          memberCount: i.member_count || 0,
          maxMemberCount: i.max_members || 0,
          admins: [],
          avatar: i.icon || '',
        } as GroupInfo)
      }
      return groups
    } catch {
      return []
    }
  }

  /** 频道成员列表 → 群成员信息 (QQ 开放平台按频道返回成员) */
  async getGroupMemberList (groupId: string, _refresh?: boolean): Promise<Array<GroupMemberInfo>> {
    try {
      const members = await this.super.getGuildMembers(groupId)
      const info: GroupMemberInfo[] = []
      for (const m of members || []) {
        const userId = String(m.user?.id || '')
        if (!userId) continue
        const name = m.nick || m.user?.username || userId
        info.push({
          userId,
          role: 'member',
          nick: name,
          name,
          sender: { userId, nick: name, name, role: 'member' },
        } as GroupMemberInfo)
      }
      return info
    } catch {
      return []
    }
  }

  async getGroupMemberInfo (_groupId: string, targetId: string, _refresh?: boolean): Promise<GroupMemberInfo> {
    const name = targetId || '未知'
    return {
      userId: targetId,
      role: 'member',
      nick: name,
      name,
      sender: { userId: targetId, nick: name, name, role: 'member' },
    } as GroupMemberInfo
  }

  async getFriendList (_refresh?: boolean): Promise<Array<UserInfo>> {
    // 开放平台无好友列表 API
    return []
  }
}

/** QQBot 协议 bot 工厂 */
export const createQqBotBot = (cfg: BotConfig): QqBotBot | undefined => {
  return new QqBotBot(cfg)
}

/** ISO/秒/毫秒 时间 → Unix 秒 */
function parseTime (ts: string | number | undefined): number {
  if (!ts) return Math.floor(Date.now() / 1000)
  if (typeof ts === 'number') return Math.floor(ts > 1e11 ? ts / 1000 : ts)
  const d = new Date(ts)
  return isNaN(d.getTime()) ? Math.floor(Date.now() / 1000) : Math.floor(d.getTime() / 1000)
}

/** 消息序号 */
function seqOf (msg: any): number {
  const n = Number(msg.msg_seq ?? msg.seq ?? 0)
  return isNaN(n) ? 0 : n
}