import {
  logger, segment, requireFileSync,
  contactFriend, contactGroup,
  senderFriend, senderGroup,
  createFriendMessage, createGroupMessage,
  createFriendIncreaseNotice, createFriendDecreaseNotice,
  createPrivateRecallNotice, createGroupRecallNotice,
  createGroupMemberAddNotice, createGroupMemberDelNotice,
  createGroupAdminChangedNotice, createGroupMessageReactionNotice,
  createPrivateApplyRequest, createGroupApplyRequest,
} from 'node-karin'
import type {
  Contact, Elements, SendElement, SendMsgResults, UserInfo, GroupInfo, GroupMemberInfo, MessageResponse,
} from 'node-karin'
import { Bot, chatIdOf } from 'douyin.ts'
import type { BotMessage, MediaInput, NoticeEvent, RequestEvent, StatusEvent } from 'douyin.ts'
import fs from 'node:fs'
import path from 'node:path'
import { dir } from '@/dir'
import { BaseBot } from '../base'
import type { BotConfig } from '../base'
import { applyMsgReplace } from '../../utils/msgReplace'
import { makeMsg, toElements, loadForwardNodes, rememberReply } from './convert'
import { mountMediaRoute } from './media'
import { rememberChat, resolveChatId, cachedSecUid, rememberSecUid, refreshContacts, loadContactCache } from './contact'
import { accountStore } from './store'
import { parsePeerFromConversationId, sdkLog } from './im'

/** 单个抖音账号的运行上下文 */
export interface DouyinContext {
  /** 账号数字 uid */
  platformUid: string
  /** douyin.ts 门面（收发/上传/联系人/HTTP） */
  bot: Bot
}

/** ChatMessage → karin MessageResponse（昵称异步查询） */
async function toMessageResponse (ctx: DouyinContext, contact: Contact, msg: {
  msgId: string
  senderUid: string
  content: string
  msgType: number
  createTime: number
  indexInConversation?: string
}): Promise<MessageResponse> {
  const nick = (await ctx.bot.nickOf(msg.senderUid)) ?? ''
  return {
    time: msg.createTime,
    messageId: msg.msgId,
    messageSeq: Number(msg.indexInConversation ?? 0),
    contact,
    sender: { userId: msg.senderUid, nick, name: nick, role: 'member' },
    elements: toElements(msg.content, msg.msgType, msg.msgId, ctx.platformUid),
  }
}

/**
 * 抖音协议适配器（douyin.ts SDK，单账号实例）:
 * 收消息走 Android Frontier WS 推送，发消息统一 HTTP cookie 通道；
 * 登录凭据由扫码登录落盘 data/douyin-accounts/<uid>/session.json 提供。
 */
export class DouyinBot extends BaseBot {
  /** douyin.ts Bot 实例（start 后可用） */
  raw: Bot
  /** 账号运行上下文（start 后可用） */
  ctx?: DouyinContext
  /** 是否已主动停止（停止后 close 事件不再视为异常断线） */
  #stopped = false

  constructor (cfg: BotConfig) {
    super(cfg)
    this.adapter.name = 'douyin'
    this.adapter.version = dir.pkg.version
    this.adapter.platform = 'douyin'
    this.adapter.standard = 'other'
    this.adapter.protocol = 'douyin'
    this.adapter.communication = 'webSocketClient'
    this.adapter.address = 'wss://frontier-msns.douyin.com/ws/v2'
    this.raw = undefined as unknown as Bot
  }

  /** 打印当前 Bot 专属日志 */
  override logger (level: 'info' | 'error' | 'trace' | 'debug' | 'mark' | 'warn' | 'fatal', ...args: any[]) {
    logger.bot(level, this.account.selfId, ...args)
  }

  /** 启动：加载本地会话 → 构建 SDK Bot → 绑定事件 → 连接 → 注册 */
  override async start (): Promise<void> {
    const uid = String(this.cfg.douyinUid || '').trim()
    if (!uid) throw new Error('[douyin] 缺少 douyinUid 配置')
    const record = accountStore.load(uid)
    if (!record?.cookie?.trim()) throw new Error(`[douyin] 未找到本地会话: ${uid}，请先扫码登录`)
    // 重复 start：先停掉旧连接再重建
    if (this.ctx) {
      this.#stopped = true
      try { this.ctx.bot.stop() } catch { /* 忽略 */ }
    }
    loadContactCacheOnce()
    mountMediaRoute()

    // 不传 userId：SDK start() 会先 self() 校验 cookie，失效直接 throw（零噪音）
    const bot = new Bot({ cookie: record.cookie, log: sdkLog })
    this.raw = bot
    this.ctx = { platformUid: uid, bot }
    this.#stopped = false
    this.#bindEvents(bot)
    try {
      await bot.start()
    } catch (err) {
      this.ctx = undefined
      const reason = err instanceof Error ? err.message : String(err)
      // SDK 校验失败提示含 Cookie 字样，统一转成面向用户的提示
      throw new Error(/cookie/i.test(reason) ? `Cookie 已失效，请重新扫码登录（${record.screenName || uid}）` : reason)
    }
    this.account = {
      uin: uid,
      uid,
      selfId: uid,
      name: record.screenName || this.cfg.douyinName || uid,
      avatar: String(record.userData?.avatar_url ?? ''),
      subId: {},
    }
    this.register()
    // im 活跃心跳上报（登录后打一次，防连接静默掉线）
    bot.user.heartbeat().catch(err => logger.debug(
      `[douyin] 心跳上报失败: ${err instanceof Error ? err.message : String(err)}`
    ))
    startRefreshTimer(this.ctx)
    logger.info(`[douyin] 账号 ${uid}(${this.account.name}) 已上线`)
  }

  /** 停止：断开 SDK 连接并注销（基类 stop 的 raw.close 对 douyin 无效，SDK 关闭方法是 stop） */
  override async stop (): Promise<void> {
    this.#stopped = true
    if (this.ctx) stopRefreshTimer(this.ctx.platformUid)
    try { this.raw.stop() } catch { /* 忽略 */ }
    this.unregister()
  }

  /** 绑定 SDK 事件 → karin 事件转换（WS 断线 SDK 自带指数退避自动重连，此处仅观测与恢复注册） */
  #bindEvents (bot: Bot): void {
    bot.on('message', msg => this.makeMessage(msg))
    bot.on('message:edited', msg => this.makeMessage(msg))
    bot.on('notice', ev => this.makeNotice(ev))
    bot.on('request', ev => this.makeRequest(ev))
    bot.on('read', ev => logger.debug(`[douyin][${this.ctx?.platformUid}] 已读回执: ${ev.conversationId}`))
    bot.on('status', ev => this.makeStatus(ev))
    bot.on('voip', ev => logger.debug(`[douyin][${this.ctx?.platformUid}] 语音来电: ${ev.callerUid}`))
    bot.on('reconnecting', ev => {
      if (!this.#stopped) {
        logger.warn(`[douyin][${this.ctx?.platformUid}] 连接断开，第 ${ev.attempt} 次重连（${ev.delayMs}ms 后）`)
      }
    })
    bot.on('close', ev => {
      if (this.#stopped) {
        logger.debug(`[douyin][${this.ctx?.platformUid}] 连接已关闭（主动操作）`)
        return
      }
      // 断线先注销；SDK 自动重连成功后由首条入站事件重新 register
      this.unregister()
      logger.warn(`[douyin][${this.ctx?.platformUid}] 连接被断开（${ev.reason || ev.code || '未知原因'}），SDK 自动重连中`)
    })
  }

  // ===== 消息 =====

  /** 发送消息（karin 调用） */
  override async sendMsg (contact: Contact, elements: Array<SendElement>): Promise<SendMsgResults> {
    return makeMsg(this.requireCtx(), contact, elements)
  }

  /** 撤回消息 */
  override async recallMsg (contact: Contact, messageId: string): Promise<void> {
    const chatId = await this.requireChatId(contact)
    const result = await this.raw.msg.recall(chatId, messageId)
    if (!result.recalled) logger.warn(`[douyin] 撤回失败: ${result.statusMsg}`)
  }

  /** 消息表情回应：faceId 1-6 为回应面板（爱心/大笑/惊讶/泪奔/赞/抱拳），文本表情键原样透传 */
  override async setMsgReaction (contact: Contact, messageId: string, faceId: string | number, isSet: boolean): Promise<void> {
    const chatId = await this.requireChatId(contact)
    const key = String(faceId)
    let emoji = ''
    if (/^\d+$/.test(key)) {
      for (const base of [dir.defResourcesDir, path.join(dir.pluginDir, 'resources')]) {
        const file = path.join(base, 'reactions.json')
        if (!fs.existsSync(file)) continue
        emoji = (requireFileSync(file) as Record<string, string>)[key] ?? ''
        break
      }
    } else {
      emoji = key
    }
    if (!emoji) throw new Error(`[douyin] 未知的表情回应 faceId: ${faceId}`)
    const result = await this.raw.msg.react(chatId, messageId, emoji, isSet)
    if (result.statusCode !== 0) logger.warn(`[douyin] 表情回应失败: statusCode=${result.statusCode} ${result.statusMsg}`)
  }

  /** 获取单条消息（重载 A：仅消息 ID，抖音需会话上下文，不支持） */
  override getMsg (messageId: string): Promise<MessageResponse>
  /** 获取单条消息（重载 B：会话 + 消息 ID，从最近历史查找） */
  override getMsg (contact: Contact, messageId: string): Promise<MessageResponse>
  override async getMsg (a: Contact | string, b?: string): Promise<MessageResponse> {
    if (typeof a === 'string') {
      throw new Error('[douyin] 抖音适配器不支持 getMsg(messageId)，请提供会话 contact')
    }
    const chatId = await this.requireChatId(a)
    const history = await this.raw.chat.history(chatId)
    const msg = b ? history.find(m => m.msgId === b) : history[history.length - 1]
    if (!msg) throw new Error(`[douyin] 未找到消息: ${b || '(最近)'}`)
    return toMessageResponse(this.requireCtx(), a, msg)
  }

  /** 获取历史消息：start 为 indexInConversation 游标（或消息 ID），返回 ≤start 的 count 条（时间正序） */
  override async getHistoryMsg (contact: Contact, start: string | number, count: number): Promise<Array<MessageResponse>> {
    const chatId = await this.requireChatId(contact)
    const limit = count || 1
    let cursor = Number(start)
    if (!Number.isFinite(cursor) || cursor <= 0) {
      // start 是消息 ID：先在最近历史中定位其 indexInConversation 作为游标
      cursor = 0
      if (start) {
        const recent = await this.raw.chat.history(chatId)
        cursor = Number(recent.find(m => m.msgId === String(start))?.indexInConversation ?? 0)
      }
    }
    const history = await this.raw.chat.history(chatId, { cursor, count: limit })
    const sorted = [...history].sort((a, b) =>
      (Number(a.indexInConversation) || 0) - (Number(b.indexInConversation) || 0)
    )
    return Promise.all(sorted.slice(-limit).map(m => toMessageResponse(this.requireCtx(), contact, m)))
  }

  /** 获取合并转发（resId = 合并转发消息 ID，取入站时缓存的节点） */
  override async getForwardMsg (resId: string): Promise<Array<MessageResponse>> {
    const nodes = loadForwardNodes(resId)
    if (!nodes?.length) throw new Error(`[douyin] 未找到合并转发: ${resId}`)
    return nodes.map((node, index) => ({
      time: node.createTime ? Math.floor(node.createTime / 1000) : Math.floor(Date.now() / 1000),
      messageId: node.msgId,
      messageSeq: index + 1,
      contact: contactFriend(node.uid, node.nickname || undefined),
      sender: { userId: node.uid, nick: node.nickname, role: 'member' },
      elements: [segment.text(node.text)],
    } as MessageResponse))
  }

  // ===== 查询 =====

  /** 好友列表（同时回填 secUid，供头像查询复用） */
  override async getFriendList (): Promise<Array<UserInfo>> {
    const list = await this.raw.frd.list()
    for (const f of list) rememberSecUid(f.uid, f.secUid)
    return list.map(f => ({ userId: f.uid, nick: f.nickname } as UserInfo))
  }

  /** 用户头像：自身取登录资料；他人按 secUid 查对话场景资料。size 对齐官方 0|100|40|140 */
  override async getAvatarUrl (userId: string, size?: 0 | 40 | 100 | 140): Promise<string> {
    const ctx = this.requireCtx()
    const uid = userId || ctx.platformUid
    const raw = uid === ctx.platformUid
      ? (await this.raw.user.self()).avatar ?? ''
      : await this.#peerAvatarUrl(uid)
    // 抖音 CDN 头像尺寸替换：`~c5_168x168.webp` → `~c5_{size}x{size}`；size=0 或无尺寸段原样返回
    const s = size ?? 0
    return raw && s ? raw.replace(/(~c5_)\d+x\d+/, `$1${s}x${s}`) : raw
  }

  /** 他人头像：按缓存 secUid 查对话场景资料 */
  async #peerAvatarUrl (uid: string): Promise<string> {
    const secUid = cachedSecUid(uid)
    if (!secUid) return ''
    const profile = await this.raw.user.profileScene(secUid).catch(() => undefined)
    return profile?.avatar ?? ''
  }

  /** 群列表（同时回填成员 secUid） */
  override async getGroupList (): Promise<Array<GroupInfo>> {
    const list = await this.raw.grp.list()
    for (const member of list.flatMap(g => g.members)) rememberSecUid(member.uid, member.secUid)
    return list.map(g => ({
      groupId: g.conversationShortId || g.conversationId,
      groupName: g.name,
      memberCount: g.members.length,
      avatar: g.avatar ?? '',
    } as GroupInfo))
  }

  /** 群信息（从群列表匹配） */
  override async getGroupInfo (groupId: string): Promise<GroupInfo> {
    const group = (await this.raw.grp.list()).find(
      g => g.conversationId === groupId || g.conversationShortId === groupId || g.name === groupId
    )
    if (!group) throw new Error(`[douyin] 未找到群: ${groupId}`)
    return {
      groupId: group.conversationShortId || group.conversationId,
      groupName: group.name,
      memberCount: group.members.length,
      avatar: group.avatar ?? '',
    } as GroupInfo
  }

  /** 群头像 */
  override async getGroupAvatarUrl (groupId: string): Promise<string> {
    const group = (await this.raw.grp.list()).find(
      g => g.conversationId === groupId || g.conversationShortId === groupId || g.name === groupId
    )
    return group?.avatar ?? ''
  }

  /** 群成员列表（secUid 回填供资料查询） */
  override async getGroupMemberList (groupId: string): Promise<Array<GroupMemberInfo>> {
    const chatId = await this.requireChatId({ scene: 'group', peer: groupId, name: '' })
    const members = await this.raw.grp.members(chatId)
    for (const m of members) rememberSecUid(m.uid, m.secUid)
    return members.map(m => ({
      userId: m.uid,
      nick: m.nickname || m.alias || m.uid,
      card: m.alias ?? '',
      // 抖音群成员 role 数字 → karin Role
      role: m.role === 1 ? 'owner' : m.role === 2 ? 'admin' : 'member',
      avatar: m.avatar ?? '',
    } as unknown as GroupMemberInfo))
  }

  /** 群成员信息 */
  override async getGroupMemberInfo (groupId: string, targetId: string): Promise<GroupMemberInfo> {
    const list = await this.getGroupMemberList(groupId)
    const member = list.find(m => m.userId === targetId)
    if (!member) throw new Error(`[douyin] 群 ${groupId} 未找到成员: ${targetId}`)
    return member
  }

  /** 陌生人信息 */
  override async getStrangerInfo (targetId: string): Promise<UserInfo> {
    const list = await this.raw.chat.strangers()
    const stranger = list.find(s => s.uid === targetId)
    if (!stranger) throw new Error(`[douyin] 未找到陌生人会话: ${targetId}`)
    return { userId: stranger.uid, nick: stranger.nickname ?? '' } as UserInfo
  }

  /** 获取账号 Cookie */
  override async getCookies (): Promise<{ cookie: string }> {
    return { cookie: this.raw.http().jar.header() }
  }

  /** 获取 QQ 相关接口凭证（抖音返回 cookie 与 passport csrf token） */
  override async getCredentials (): Promise<{ cookies: string, csrf_token: number }> {
    const csrf = Number(this.raw.http().jar.get('passport_csrf_token') ?? 0)
    return { cookies: this.raw.http().jar.header(), csrf_token: Number.isFinite(csrf) ? csrf : 0 }
  }

  /** 获取 CSRF Token */
  override async getCSRFToken (): Promise<{ token: number }> {
    const csrf = Number(this.raw.http().jar.get('passport_csrf_token') ?? 0)
    return { token: Number.isFinite(csrf) ? csrf : 0 }
  }

  // ===== 管理/互动 =====

  /** 处理好友申请（flag = 申请者 uid） */
  override async setFriendApplyResult (flag: string, isApprove: boolean): Promise<void> {
    if (isApprove) await this.raw.frd.approve(flag)
    else await this.raw.frd.reject(flag)
  }

  /** 处理入群申请（flag = requestId） */
  override async setGroupApplyResult (flag: string, isApprove: boolean): Promise<void> {
    if (isApprove) await this.raw.grp.approve(flag)
    else await this.raw.grp.reject(flag)
  }

  /** 设置群名（cmd=902 set_conversation_core_info） */
  override async setGroupName (groupId: string, groupName: string): Promise<void> {
    const chatId = await this.requireChatId({ scene: 'group', peer: groupId, name: '' })
    const result = await this.raw.grp.rename(chatId, groupName)
    if (result.statusCode !== 0) {
      throw new Error(`[douyin] 设置群名失败: ${result.statusMsg} (code=${result.statusCode})`)
    }
  }

  /** 群踢人（SDK 成员移除；rejectAddRequest/kickReason 抖音无对等入参，忽略） */
  override async groupKickMember (groupId: string, targetId: string): Promise<void> {
    const chatId = await this.requireChatId({ scene: 'group', peer: groupId, name: '' })
    const result = await this.raw.grp.removeMembers(chatId, [targetId])
    if (result.statusCode !== 0) {
      throw new Error(`[douyin] 群踢人失败: ${result.statusMsg} (code=${result.statusCode})`)
    }
  }

  /** 退出群聊（抖音 Leave 无解散/退出之分，isDismiss 忽略） */
  override async setGroupQuit (groupId: string, _isDismiss: boolean): Promise<void> {
    const chatId = await this.requireChatId({ scene: 'group', peer: groupId, name: '' })
    const result = await this.raw.grp.leave(chatId)
    if (result.statusCode !== 0) {
      throw new Error(`[douyin] 退群失败: ${result.statusMsg} (code=${result.statusCode})`)
    }
  }

  // ===== SDK 独有能力透传（karin 无标准接口的方法，插件可通过 e.bot.xxx 直接调用） =====

  sendTyping (chatId: string, typing = true) {
    return this.raw.msg.sendTyping(chatId, typing)
  }

  addGroupMembers (chatId: string, uids: string[]) {
    return this.raw.grp.addMembers(chatId, uids)
  }

  getGroupRequests (chatId?: string) {
    return this.raw.grp.requests(chatId)
  }

  createGroup (options: { participantUids: string[], name?: string, description?: string }) {
    return this.raw.grp.create(options)
  }

  getChatInfo (chatId: string) {
    return this.raw.chat.info(chatId)
  }

  deleteChat (chatId: string) {
    return this.raw.chat.delete(chatId)
  }

  setChatSetting (chatId: string, input: { setStickOnTop?: boolean, setMute?: boolean, setFavorite?: boolean }) {
    return this.raw.chat.setting(chatId, input)
  }

  readSwitch (chatId: string, msgs: BotMessage[]) {
    return this.raw.chat.readSwitch(chatId, msgs)
  }

  getReadIndex (chatId: string) {
    return this.raw.chat.readIndex(chatId)
  }

  getMinIndex (chatId: string) {
    return this.raw.chat.minIndex(chatId)
  }

  getStrangers () {
    return this.raw.chat.strangers()
  }

  getStrangerConversations () {
    return this.raw.chat.strangerConversations()
  }

  getOnlineStatus (secUserIds: string[], source?: string) {
    return this.raw.user.onlineStatus(secUserIds, source)
  }

  heartbeat () {
    return this.raw.user.heartbeat()
  }

  activeSwitch () {
    return this.raw.user.activeSwitch()
  }

  getEmojiList () {
    return this.raw.media.emojiList()
  }

  getVideoUrl (tkey: string) {
    return this.raw.media.videoUrl(tkey)
  }

  uploadImage (input: MediaInput) {
    return this.raw.media.image(input)
  }

  uploadVideo (input: MediaInput) {
    return this.raw.media.video(input)
  }

  uploadMedia (input: MediaInput, name?: string) {
    return this.raw.media.file(input, name)
  }

  getAwemeDetail (awemeIds: string[], options?: { originType?: string, requestSource?: number, conversationShortId?: string }) {
    return this.raw.media.awemeDetail(awemeIds, options)
  }

  // ===== 入站事件转换 =====

  /** 抖音入站消息 → karin 消息事件（SDK 已补 chatId/senderNickname/视频直链） */
  makeMessage (msg: BotMessage): void {
    try {
      // 空文本推送（如 aweType=133 系统引导模板）无内容价值，不分发
      if (msg.type === 'text' && !msg.text) return

      // 断线重连成功后的首条事件：恢复 karin 注册（幂等）
      this.register()
      const ctx = this.requireCtx()
      rememberChat(ctx.bot, msg)
      rememberReply(ctx, msg)
      const messageId = msg.serverMessageId || `${msg.cmd}-${msg.indexInConversationV2 ?? msg.indexInConversation ?? Date.now()}`
      // 入站文本段应用消息正则替换 (如 /命令 → #命令)
      const elements = applyMsgReplace(
        toElements(msg.content, msg.messageType, messageId, ctx.platformUid, msg.reference),
        this.cfg.msgReplace, this.cfg.msgReplaceEnable,
      )
      const seq = Number(msg.indexInConversationV2 || msg.indexInConversation || msg.serverMessageId || 0) ||
        Math.floor(Date.now() / 1000)
      const time = Number(msg.createTime) > 0 ? Math.floor(Number(msg.createTime) / 1000) : Math.floor(Date.now() / 1000)
      const nick = msg.senderNickname

      if (msg.conversationType === 2) {
        const peer = msg.conversationShortId || msg.conversationId
        const contact = contactGroup(peer)
        createGroupMessage({
          bot: this,
          contact,
          elements,
          eventId: messageId,
          messageId,
          messageSeq: seq,
          rawEvent: msg.raw,
          sender: senderGroup(msg.senderUid, 'member', nick),
          time,
          srcReply: elems => this.sendMsg(contact, elems),
        })
      } else {
        const peer = parsePeerFromConversationId(msg.conversationId, ctx.platformUid) || msg.senderUid
        const contact = contactFriend(peer, nick)
        createFriendMessage({
          bot: this,
          contact,
          elements,
          eventId: messageId,
          messageId,
          messageSeq: seq,
          rawEvent: msg.raw,
          sender: senderFriend(msg.senderUid, nick),
          time,
          srcReply: elems => this.sendMsg(contact, elems),
        })
      }
    } catch (err) {
      logger.error('[douyin] 处理入站消息失败:', err)
    }
  }

  /** 抖音通知事件 → karin 通知事件 */
  makeNotice (ev: NoticeEvent): void {
    try {
      this.register()
      switch (ev.type) {
        case 'message.reaction': {
          const faceId = emojiToFaceId(ev.emoji)
          logger.info(
            `[douyin] 表情回应: msgId=${ev.serverMessageId} emoji=${ev.emoji} ` +
            `operator=${ev.operatorUid} isSet=${ev.isSet}`
          )
          // karin 仅提供群 reaction 事件类型（会话 0:2:*）；私聊回应仅日志
          if (!ev.conversationId.startsWith('0:2:')) return
          const contact = contactGroup(ev.conversationId.split(':')[2] || ev.conversationId)
          createGroupMessageReactionNotice({
            ...this.#noticeCommon(ev.raw),
            contact,
            sender: senderGroup(ev.operatorUid, 'member'),
            srcReply: elems => this.sendMsg(contact, elems),
            content: { messageId: ev.serverMessageId, faceId, count: 1, isSet: ev.isSet },
          })
          return
        }
        case 'friend.increase':
        case 'friend.decrease': {
          const contact = contactFriend(ev.peerUid)
          const sender = senderFriend(ev.peerUid)
          const srcReply = (elems: Elements[]) => this.sendMsg(contact, elems)
          const common = { ...this.#noticeCommon(ev.raw), contact, sender, srcReply }
          if (ev.type === 'friend.increase') {
            createFriendIncreaseNotice({ ...common, content: { targetId: ev.peerUid } })
          } else {
            createFriendDecreaseNotice({ ...common, content: { targetId: ev.peerUid } })
          }
          break
        }

        case 'message.recall': {
          const messageId = ev.serverMessageId ?? ''
          const operatorId = ev.recallUid ?? ''
          if (ev.conversationType === 2) {
            const contact = contactGroup(ev.conversationId.split(':')[2] || ev.conversationId)
            createGroupRecallNotice({
              ...this.#noticeCommon(ev.raw),
              contact,
              sender: senderGroup(operatorId, 'member'),
              srcReply: elems => this.sendMsg(contact, elems),
              content: { operatorId, targetId: operatorId, messageId, tip: '' },
            })
          } else {
            const peer = parsePeerFromConversationId(ev.conversationId, this.selfId) || ev.conversationId
            const contact = contactFriend(peer)
            createPrivateRecallNotice({
              ...this.#noticeCommon(ev.raw),
              contact,
              sender: senderFriend(peer),
              srcReply: elems => this.sendMsg(contact, elems),
              content: { operatorId: peer, messageId, tips: '' },
            })
          }
          break
        }

        case 'group.member-increase': {
          const contact = contactGroup(ev.conversationShortId || ev.conversationId)
          const base = {
            ...this.#noticeCommon(ev.raw),
            contact,
            srcReply: (elems: Elements[]) => this.sendMsg(contact, elems),
          }
          for (const member of ev.members) {
            // 登记去重：status 补漏通道会检查此 key，避免同一变更双发
            claimMemberChange(`${groupPeerOf(ev.conversationId)}:${member.uid}:increase`)
            createGroupMemberAddNotice({
              ...base,
              sender: senderGroup(member.uid, 'member'),
              content: {
                operatorId: ev.operators[0]?.uid ?? '',
                targetId: member.uid,
                type: ev.source === 'invite' ? 'invite' : 'approve',
              },
            })
          }
          break
        }

        case 'group.member-decrease': {
          const contact = contactGroup(ev.conversationShortId || ev.conversationId)
          const base = {
            ...this.#noticeCommon(ev.raw),
            contact,
            srcReply: (elems: Elements[]) => this.sendMsg(contact, elems),
          }
          for (const member of ev.members) {
            // 登记去重：status 补漏通道会检查此 key，避免同一变更双发
            claimMemberChange(`${groupPeerOf(ev.conversationId)}:${member.uid}:decrease`)
            createGroupMemberDelNotice({
              ...base,
              sender: senderGroup(member.uid, 'member'),
              content: {
                operatorId: ev.operators[0]?.uid ?? '',
                targetId: member.uid,
                type: ev.source === 'kick' ? 'kick' : 'leave',
              },
            })
          }
          break
        }

        case 'group.admin': {
          const contact = contactGroup(ev.conversationShortId || ev.conversationId)
          const base = {
            ...this.#noticeCommon(ev.raw),
            contact,
            srcReply: (elems: Elements[]) => this.sendMsg(contact, elems),
          }
          for (const member of ev.members) {
            createGroupAdminChangedNotice({
              ...base,
              sender: senderGroup(member.uid, 'member'),
              content: { targetId: member.uid, isAdmin: true },
            })
          }
          break
        }

        case 'conversation.typing':
          // karin 无输入状态通知，仅记日志（周期上报，用 debug 防刷屏）
          logger.debug(`[douyin] 输入状态: ${ev.peerUid} typing=${ev.typing}`)
          return

        case 'group.name-change':
          logger.info(`[douyin] 群名变更: ${ev.conversationShortId} 新名=${ev.name ?? '(未知)'}`)
          return

        case 'group.avatar-change':
          logger.info(`[douyin] 群头像变更: ${ev.conversationShortId}`)
          return

        default:
          logger.debug('[douyin] 未处理通知:', ev.type)
      }
    } catch (err) {
      logger.error('[douyin] 处理通知事件失败:', err)
    }
  }

  /** 会话状态事件 → karin 通知事件（补漏：部分群成员增减服务端仅下发 status，无系统消息） */
  makeStatus (ev: StatusEvent): void {
    try {
      this.register()
      const ctx = this.requireCtx()
      // 仅群成员变更（commandType=7）补漏，其余状态同步维持 debug 日志
      if (ev.commandType !== 7) {
        logger.debug(`[douyin][${ctx.platformUid}] 会话状态变更: ${ev.conversationId} cmd=${ev.commandType}`)
        return
      }
      const change = ev.memberChange
      if (!change) return
      const peer = groupPeerOf(ev.conversationId)
      const contact = contactGroup(peer)
      const base = {
        ...this.#noticeCommon(ev.raw),
        contact,
        srcReply: (elems: Elements[]) => this.sendMsg(contact, elems),
      }
      for (const uid of change.added ?? []) {
        if (isSelfUid(ctx.platformUid, uid)) {
          logger.info(`[douyin] 机器人加入群聊: ${peer}`)
          continue
        }
        // notice 通道已派发过的（2 分钟内）跳过，避免重复
        if (!claimMemberChange(`${peer}:${uid}:increase`)) continue
        createGroupMemberAddNotice({
          ...base,
          sender: senderGroup(uid, 'member'),
          content: { operatorId: '', targetId: uid, type: 'invite' },
        })
      }
      for (const uid of change.removed ?? []) {
        if (isSelfUid(ctx.platformUid, uid)) {
          logger.info(`[douyin] 机器人退出群聊: ${peer}`)
          continue
        }
        if (!claimMemberChange(`${peer}:${uid}:decrease`)) continue
        createGroupMemberDelNotice({
          ...base,
          sender: senderGroup(uid, 'member'),
          content: { operatorId: '', targetId: uid, type: 'leave' },
        })
      }
    } catch (err) {
      logger.error('[douyin] 处理会话状态事件失败:', err)
    }
  }

  /** 抖音请求事件 → karin 请求事件 */
  async makeRequest (ev: RequestEvent): Promise<void> {
    try {
      this.register()
      if (ev.type === 'friend.request') {
        const contact = contactFriend(ev.applicantUid)
        createPrivateApplyRequest({
          bot: this,
          subEvent: 'friendApply',
          contact,
          sender: senderFriend(ev.applicantUid),
          eventId: `douyin-friend-request-${ev.applicantUid}-${Date.now()}`,
          rawEvent: ev.raw,
          time: Math.floor(Date.now() / 1000),
          srcReply: elems => this.sendMsg(contact, elems),
          content: { applierId: ev.applicantUid, message: ev.content ?? '', flag: ev.applicantUid },
        })
        return
      }

      // group.join-request：推送不含申请人信息，拉取审核列表补全后再派发
      const chatId = chatIdOf({
        conversationId: ev.conversationId,
        conversationShortId: ev.conversationShortId,
        conversationType: ev.conversationType,
      })
      const list = await this.raw.grp.requests(chatId)
      // 审核状态 1=待处理（SDK 枚举未导出，按字面量）
      const pending = ev.requestId
        ? list.find(r => r.requestId === ev.requestId)
        : list.find(r => r.status === 1)
      if (!pending) {
        logger.debug('[douyin] 入群申请审核列表未命中，忽略')
        return
      }

      const contact = contactGroup(ev.conversationShortId || ev.conversationId)
      createGroupApplyRequest({
        bot: this,
        subEvent: 'groupApply',
        contact,
        sender: senderGroup(pending.applicantUid, 'member'),
        eventId: `douyin-group-request-${pending.requestId}-${Date.now()}`,
        rawEvent: ev.raw,
        time: Math.floor(Date.now() / 1000),
        srcReply: elems => this.sendMsg(contact, elems),
        content: {
          applierId: pending.applicantUid,
          inviterId: pending.inviterUid ?? '',
          reason: pending.reason ?? ev.content ?? '',
          flag: pending.requestId,
          groupId: ev.conversationShortId || ev.conversationId,
        },
      })
    } catch (err) {
      logger.error('[douyin] 处理请求事件失败:', err)
    }
  }

  // ===== 内部工具 =====

  /** 获取运行上下文（未启动时抛错） */
  private requireCtx (): DouyinContext {
    if (!this.ctx) throw new Error('[douyin] Bot 未启动，无法执行该操作')
    return this.ctx
  }

  /** 解析 karin contact → 抖音 chatId（缓存未命中查好友/群列表） */
  private async requireChatId (contact: Contact): Promise<string> {
    const chatId = await resolveChatId(this.requireCtx(), contact)
    if (!chatId) throw new Error(`[douyin] 无法解析会话目标: ${contact.scene} ${contact.peer}`)
    return chatId
  }

  /** 通知事件公共参数（eventId/rawEvent/time 由调用方补 contact/sender/content） */
  #noticeCommon (raw: Record<string, unknown>) {
    return {
      bot: this,
      eventId: `douyin-notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      rawEvent: raw,
      time: Math.floor(Date.now() / 1000),
    }
  }
}

/** 抖音表态键值 → karin faceId（resources/reactions.json 反查，未收录返回 0） */
function emojiToFaceId (emoji: string): number {
  for (const base of [dir.defResourcesDir, path.join(dir.pluginDir, 'resources')]) {
    const file = path.join(base, 'reactions.json')
    if (!fs.existsSync(file)) continue
    const table = requireFileSync(file) as Record<string, string>
    const hit = Object.entries(table).find(([, key]) => key === emoji)
    if (hit) return Number(hit[0])
  }
  return 0
}

/** 群成员变更去重表：`${群id}:${uid}:${增加|减少}` → 派发时间戳（status 与 notice 双通道会各自下发同一变更） */
const memberSeen = new Map<string, number>()
/** 记录并返回是否为窗口期内首次（2 分钟内视为同一变更已派发过，仅 status 通道在派发前检查） */
function claimMemberChange (key: string): boolean {
  const seen = memberSeen.get(key)
  if (seen && Date.now() - seen < 120000) return false
  memberSeen.set(key, Date.now())
  // 防无限增长：超过 500 条时清空
  if (memberSeen.size > 500) memberSeen.clear()
  return true
}

/** 群会话 ID（`0:2:{群id}`）→ 群 id；status 的 conversationId 可能为纯群 id，原样兜底 */
function groupPeerOf (conversationId: string): string {
  return conversationId.startsWith('0:2:') ? conversationId.slice(4) : conversationId
}

/** bot 自身 uid 判定：SDK 大数无精度保护，尾部可能截 0，前 15 位比对兜底 */
function isSelfUid (selfUid: string, uid: string): boolean {
  return uid === selfUid || (uid.length === selfUid.length && uid.slice(0, 15) === selfUid.slice(0, 15))
}

/** karin 标准接口中抖音平台不支持的方法名（批量绑定报错 stub；writable/configurable 必须为 true：
 * node-karin registerBot 会对 sendMsg 等做钩子包装赋值，只读属性会导致注册失败） */
const UNSUPPORTED = [
  'setInvitedJoinGroupResult', 'sendLike', 'pokeUser', 'createResId',
  'sendForwardMsg', 'sendLongMsg',
  'setGroupMute', 'setGroupAllMute', 'setGroupMemberCard', 'setGroupAdmin',
  'setGroupMemberTitle', 'setGroupSpecialTitle', 'setGroupNotice', 'delGroupNotice',
  'setEssenceMsg', 'deleteEssenceMsg', 'getGroupHighlights', 'setGroupPortrait',
  'setGroupRemark', 'getGroupHonor', 'getNotJoinedGroupInfo', 'getGroupMuteList',
  'getGroupAtAllRemain', 'getAtAllCount',
  'uploadFile', 'uploadGroupFile', 'uploadPrivateFile', 'downloadFile', 'getFileUrl',
  'getPrivateFileUrl', 'getRkey', 'getGroupFileList', 'getGroupFileSystemInfo',
  'getGroupFileUrl', 'getGroupRootFiles', 'getGroupFilesByFolder', 'createGroupFileFolder',
  'deleteGroupFile', 'deleteGroupFolder', 'renameGroupFolder', 'moveGroupFile',
  'setAvatar', 'deleteFriend', 'deleteUnidirectionalFriend', 'getUnidirectionalFriendList',
  'sendGroupSign', 'sendGroupAiRecord', 'sendAiCharacter', 'getAiCharacters',
  'ocrImage', 'getImage', 'getRecord', 'getWordSlices', 'fetchCustomFace', 'getGroupSystemMsg',
] as const

/** 打印不支持日志并抛错（模块级函数，供批量绑定 stub 调用） */
function unsupported (method: string): never {
  logger.error(`[douyin] 抖音适配器不支持: ${method}`)
  throw new Error(`[douyin] 抖音适配器不支持: ${method}`)
}

// 批量绑定不支持的接口方法
for (const name of UNSUPPORTED) {
  Object.defineProperty(DouyinBot.prototype, name, {
    value: (): never => unsupported(name),
    writable: true,
    configurable: true,
  })
}

/** 好友/群列表防漂移刷新定时器：platformUid → timer */
const refreshTimers = new Map<string, NodeJS.Timeout>()

/** 启动 30 分钟好友/群列表周期刷新（防群名/成员漂移），断线期间失败仅告警 */
function startRefreshTimer (ctx: DouyinContext): void {
  stopRefreshTimer(ctx.platformUid)
  const timer = setInterval(() => {
    refreshContacts(ctx).catch(err => logger.warn(
      `[douyin][${ctx.platformUid}] 联系人列表刷新失败: ${err instanceof Error ? err.message : String(err)}`
    ))
  }, 30 * 60 * 1000)
  refreshTimers.set(ctx.platformUid, timer)
}

/** 停止账号的周期刷新定时器 */
function stopRefreshTimer (uid: string): void {
  const timer = refreshTimers.get(uid)
  if (timer) clearInterval(timer)
  refreshTimers.delete(uid)
}

/** 联系人缓存仅加载一次 */
let contactCacheLoaded = false

/** 启动时从磁盘加载联系人缓存（幂等） */
function loadContactCacheOnce (): void {
  if (contactCacheLoaded) return
  contactCacheLoaded = true
  loadContactCache()
}

/** douyin 协议 bot 工厂：缺 douyinUid 时返回 undefined */
export const createDouyinBot = (cfg: BotConfig): DouyinBot | undefined => {
  if (!String(cfg.douyinUid || '').trim()) {
    logger.warn('[douyin] 缺少 douyinUid 配置，跳过启动')
    return undefined
  }
  return new DouyinBot(cfg)
}
