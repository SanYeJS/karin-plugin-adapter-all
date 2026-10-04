import { logger } from 'node-karin'
import type {
  Contact,
  Elements,
  ForwardOptions,
  GetGroupHighlightsResponse,
  GroupInfo,
  GroupMemberInfo,
  MessageResponse,
  NodeElement,
  SendElement,
  SendMsgResults,
  UserInfo,
} from 'node-karin'
import { version } from '@saltify/milky-types/package.json'
import { BaseBot } from '../base'
import type { BotConfig } from '../base'
import { Client } from './client'
import type { MessageScene } from './msgId'
import { createMilkyEventChannel, type MilkyEventChannel } from './eventChannel'
import { AdapterConvertKarin, KarinConvertAdapter } from './convert'
import { segment as Segment } from './segment'
import { EventDispatch } from './event'
import { InvitationCache } from './invitationCache'
import { findGroupNotification } from './notificationLookup'

/**
 * milky 协议适配器: 协议端本地运行(Lagrange.Milky / Yogurt),
 * HTTP 发 API(POST {url}/api/<action>, Bearer 鉴权) + 事件接收支持三种方式:
 *  ws(WebSocket) / sse(SSE) / webhook(本端 HTTP 服务接收协议端推送)。
 */
export class MilkyBot extends BaseBot {
  /** milky HTTP 客户端 */
  super: Client
  /** 事件接收通道 (stop 时关闭) */
  raw: MilkyEventChannel
  /** 邀请自身入群事件的 invitation_seq → group_id 缓存 */
  invitations = new InvitationCache()
  /** 是否已完成初始化(拉取登录信息) */
  #inited = false
  /** 是否已主动停止(停止后不再自动重连) */
  #stopped = false
  /** 连接起始时间 */
  #startTime = 0
  /** 连接时长计时器 */
  #connectTimeTimer: NodeJS.Timeout | null = null

  constructor (cfg: BotConfig) {
    super(cfg)
    this.super = new Client(cfg.url, cfg.accessToken)
    this.raw = createMilkyEventChannel(cfg)
    this.adapter.name = 'Milky'
    this.adapter.version = version
    this.adapter.platform = 'qq'
    this.adapter.standard = 'milky'
    // getImplInfo 成功后会用协议端 impl_name 覆盖
    this.adapter.protocol = 'milky'
    // 事件接收方式对应 Karin 通信方式展示: ws→webSocketClient sse→sse webhook→http(本端收上报)
    this.adapter.communication = this.raw.mode === 'webhook' ? 'http' : (this.raw.mode === 'sse' ? 'sse' : 'webSocketClient')
    this.adapter.address = this.raw.address
  }

  /** 注册 Bot (ws 连接建立后调用) */
  __registerBot () {
    this.register()
  }

  /** 注销 Bot (bot_offline 事件 / ws 断开时调用) */
  __unregisterBot () {
    this.unregister()
  }

  /** 打印当前 Bot 专属日志 */
  logger (level: 'info' | 'error' | 'trace' | 'debug' | 'mark' | 'warn' | 'fatal', ...args: any[]) {
    logger.bot(level, this.account.selfId, ...args)
  }

  /** 直通 milky API */
  async sendApi (action: string, params?: any) {
    return this.super.request(action, params)
  }

  /** 消息 ID 编码: 供段转换层/事件层把 (scene, peerId, seq) 编码为 milky 消息 ID */
  encodeMsgId (scene: MessageScene, peerId: number, seq: number): string {
    return this.super.encodeMsgId(scene, peerId, seq)
  }

  /** 拉取登录信息 + 实现信息 (失败抛错, 由 start 重试) */
  async #init () {
    if (this.#inited) return
    const info = await this.super.getLoginInfo()
    if (!info) throw new Error('获取登录信息失败')
    const selfId = String(info.uin)
    this.account = {
      uin: selfId,
      uid: selfId,
      selfId,
      name: info.nickname,
      avatar: `https://q1.qlogo.cn/g?b=qq&s=0&nk=${selfId}`,
      subId: {},
    }
    const imp = await this.super.getImplInfo()
    if (imp) this.adapter.protocol = imp.impl_name
    this.#inited = true
    return true
  }

  /** 连接建立: 启动连接计时 + 注册 Bot */
  #onOpen () {
    this.#startTime = Date.now()
    if (this.#connectTimeTimer) clearInterval(this.#connectTimeTimer)
    this.#connectTimeTimer = setInterval(() => {
      this.adapter.connectTime = Date.now() - this.#startTime
    }, 1000)
    this.__registerBot()
    this.logger('info', `连接成功: ${this.adapter.address}`)
  }

  /** 收到事件: 分发到 milky 事件处理层 */
  #onEvent (event: any) {
    try {
      EventDispatch(event, this)
    } catch (err: any) {
      this.logger('error', `事件处理错误: ${err.message}`)
    }
  }

  /** 连接断开: 注销 Bot + 停连接计时 (重连由通道内部处理) */
  #onClose () {
    this.__unregisterBot()
    if (this.#connectTimeTimer) {
      clearInterval(this.#connectTimeTimer)
      this.#connectTimeTimer = null
    }
  }

  /** 启动: 初始化登录信息 + 建立事件接收 (ws/sse/webhook 三种方式) */
  async start () {
    if (this.raw.isConnected) return
    if (this.#stopped) this.#stopped = false
    await this.#init()
    this.raw.start({
      onOpen: () => this.#onOpen(),
      onMessage: (event) => this.#onEvent(event),
      onError: (err) => this.logger('error', `事件连接错误: ${err.message}`),
      onClose: () => this.#onClose(),
    })
  }

  /** 停止: 断开事件接收并注销 (热更新/停用时调用) */
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
    const msg = await KarinConvertAdapter(elements)
    let res
    if (contact.scene === 'group') {
      res = await this.super.sendGroupMessage(+contact.peer, msg)
    } else if (contact.scene === 'friend') {
      res = await this.super.sendPrivateMessage(+contact.peer, msg)
    } else {
      throw new Error('不支持的操作')
    }
    result.messageId = this.super.encodeMsgId(contact.scene === 'group' ? 'group' : 'friend', +contact.peer, res.message_seq)
    result.time = res.time
    result.rawData = res
    return result
  }

  async sendForwardMsg (_contact: Contact, _elements: Array<NodeElement>, _options?: ForwardOptions) {
    const userId = +this.account.selfId
    const NickName = this.account.name
    const messages = []
    for (const v of _elements) {
      const userid = v.subType === 'fake' ? +v.userId : userId
      const nickname = v.subType === 'fake' ? v.nickname : NickName
      const content = v.subType === 'fake' ? v.message : (await this.getForwardMsg(v.messageId))[0].elements
      const message = await KarinConvertAdapter(content)
      messages.push(Segment.fake(userid, message, nickname))
    }
    const data = Segment.node(messages)
    const result = { messageId: '', forwardId: '' }
    if (_contact.scene === 'friend') {
      const res = await this.super.sendPrivateMessage(+_contact.peer, data)
      result.messageId = this.super.encodeMsgId('friend', +_contact.peer, res.message_seq)
    } else {
      const res = await this.super.sendGroupMessage(+_contact.peer, data)
      result.messageId = this.super.encodeMsgId('group', +_contact.peer, res.message_seq)
    }
    return result
  }

  async recallMsg (contact: Contact, messageId: string): Promise<void> {
    const Id = +contact.peer
    const { seq } = this.super.decodeMsgId(messageId)
    if (contact.scene === 'group') {
      await this.super.recallGroupMessage(Id, seq)
    } else if (contact.scene === 'friend') {
      await this.super.recallPrivateMessage(Id, seq)
    }
  }

  async getMsg (Contact: Contact | string, messageId?: string): Promise<MessageResponse> {
    let peerId: number | string, scene: 'group' | 'friend' | 'temp', seq
    if (typeof Contact === 'string') {
      ({ scene, peerId, seq } = this.super.decodeMsgId(Contact))
    } else {
      scene = Contact.scene === 'friend' ? 'friend' : Contact.scene === 'group' ? 'group' : 'temp'
      peerId = Contact.peer;
      ({ seq } = this.super.decodeMsgId(messageId!))
    }
    const { message } = await this.super.getMessage(scene, +peerId, seq)
    const userId = String(message.sender_id)
    const nickname = message.message_scene === 'friend' ? message.friend.nickname : message.message_scene === 'group' ? message.group_member.nickname : ''
    const contact = message.message_scene === 'friend'
      ? { scene: 'friend' as const, peer: String(message.friend.user_id), name: message.friend.nickname }
      : message.message_scene === 'group'
        ? { scene: 'group' as const, peer: String(message.group.group_id), name: message.group.group_name }
        : { scene: 'groupTemp' as const, peer: String(message.group?.group_id), subPeer: String(message.sender_id) }
    return {
      time: message.time,
      messageId: this.super.encodeMsgId(message.message_scene, message.peer_id, message.message_seq),
      messageSeq: message.message_seq,
      contact: contact as Contact,
      sender: {
        role: message.message_scene === 'group' ? message.group_member.role : 'unknown',
        userId,
        nick: nickname,
        name: nickname,
      },
      elements: await AdapterConvertKarin(message, this),
    } as MessageResponse
  }

  async getHistoryMsg (contact: Contact, startMsgSeq: string | number, count: number): Promise<MessageResponse[]> {
    const MsgId = typeof startMsgSeq === 'string' ? this.super.decodeMsgId(startMsgSeq).seq : startMsgSeq
    const scene = contact.scene === 'friend' ? 'friend' : contact.scene === 'group' ? 'group' : 'temp'
    /**
     * milky 服务端的两个限制, 在这里对齐 karin 的语义:
     * 1. limit 上限 30, 超出直接报错——按 30 一批循环拉取直到凑够 count 或没有更早消息
     * 2. start_message_seq 是「结尾含锚点」语义, 传 0 恒返回空——0/缺省时不传该参数, 拉最新一页
     */
    const result: Awaited<ReturnType<Client['getHistoryMessage']>>['messages'] = []
    let cursor = MsgId > 0 ? MsgId : undefined
    while (result.length < count) {
      const batch = Math.min(30, count - result.length)
      const res = (await this.super.getHistoryMessage(scene, +contact.peer, cursor, batch)).messages
      if (res.length === 0) break
      // 每批按 seq 升序、以 cursor 结尾; 往更早翻页时拼到前面
      result.unshift(...res)
      const oldest = res[0].message_seq
      if (res.length < batch || oldest <= 1) break
      cursor = oldest - 1
    }
    const elements: MessageResponse[] = []
    for (const i of result) {
      const userId = String(i.sender_id)
      const nickname = i.message_scene === 'friend' ? i.friend.nickname : i.message_scene === 'group' ? i.group_member.nickname : ''
      elements.push({
        time: i.time,
        messageId: this.super.encodeMsgId(i.message_scene, i.peer_id, i.message_seq),
        messageSeq: i.message_seq,
        contact: (i.message_scene === 'friend'
          ? { scene: 'friend' as const, peer: String(i.friend.user_id), name: i.friend.nickname }
          : i.message_scene === 'group'
            ? { scene: 'group' as const, peer: String(i.group.group_id), name: i.group.group_name }
            : { scene: 'groupTemp' as const, peer: String(i.group?.group_id), subPeer: String(i.sender_id) }) as Contact,
        sender: {
          role: i.message_scene === 'group' ? i.group_member.role : 'unknown',
          userId,
          nick: nickname,
          name: nickname,
        },
        elements: await AdapterConvertKarin(i, this),
      })
    }
    return elements
  }

  async getForwardMsg (_resId: string): Promise<Array<MessageResponse>> {
    const info = await this.super.getForwardedMessage(_resId)
    const result: MessageResponse[] = []
    for (const v of info.messages) {
      const messageSeq = v.message_seq ?? 0
      /**
       * 转发消息本身没有 peer_id / sender_id, 这里合成一个 IncomingMessage 形态
       * 以复用 AdapterConvertKarin 的段转换逻辑; group 等上下文留空。
       */
      const synthetic = {
        message_scene: 'group' as const,
        peer_id: 0,
        message_seq: messageSeq,
        sender_id: 0,
        time: v.time,
        segments: v.segments,
        group: { group_id: 0, group_name: '', member_count: 0, max_member_count: 0 } as never,
        group_member: {
          user_id: 0,
          nickname: v.sender_name,
          sex: 'unknown',
          card: '',
          title: '',
          level: 0,
          role: 'member',
          join_time: 0,
          last_sent_time: 0,
          group_id: 0,
        } as never,
      }
      result.push({
        time: v.time,
        messageId: messageSeq ? this.super.encodeMsgId('group', 0, messageSeq) : '',
        messageSeq,
        contact: { scene: 'group', peer: '0', name: '' } as any,
        sender: {
          userId: '0',
          nick: v.sender_name,
          name: v.sender_name,
          role: 'member',
        },
        elements: await AdapterConvertKarin(synthetic as never, this),
      } as MessageResponse)
    }
    return result
  }

  async setMsgReaction (contact: Contact, messageId: string, faceId: number | string, isSet: boolean): Promise<void> {
    if (contact.scene !== 'group') throw new Error('仅支持群聊设置表情回应')
    const seq = this.super.decodeMsgId(messageId).seq
    const reaction = String(faceId)
    const reactionType: 'face' | 'emoji' = /^\d+$/.test(reaction) ? 'face' : 'emoji'
    await this.super.sendGroupMessageReaction(+contact.peer, seq, reaction, reactionType, isSet)
  }

  // ===== 群管 =====
  async groupKickMember (_groupId: string, _targetId: string, _rejectAddRequest?: boolean, _kickReason?: string): Promise<void> {
    await this.super.kickGroupMember(+_groupId, +_targetId, _rejectAddRequest)
  }

  async setGroupMute (_groupId: string, _targetId: string, _duration: number): Promise<void> {
    await this.super.setGroupMemberMute(+_groupId, +_targetId, _duration)
  }

  async setGroupAllMute (_groupId: string, _isBan: boolean): Promise<void> {
    await this.super.setGroupWholeMute(+_groupId, _isBan)
  }

  async setGroupAdmin (_groupId: string, _targetId: string, _isAdmin: boolean): Promise<void> {
    await this.super.setGroupMemberAdmin(+_groupId, +_targetId, _isAdmin)
  }

  async setGroupMemberCard (_groupId: string, _targetId: string, _card: string): Promise<void> {
    await this.super.setGroupMemberCard(+_groupId, +_targetId, _card)
  }

  async setGroupName (_groupId: string, _groupName: string): Promise<void> {
    await this.super.setGroupName(+_groupId, _groupName)
  }

  async setGroupQuit (_groupId: string, _isDismiss: boolean): Promise<void> {
    const info = await this.getGroupMemberInfo(_groupId, this.account.selfId)
    if (['owner'].includes(info.role) && !_isDismiss) return
    await this.super.quitGroup(+_groupId)
  }

  async setGroupMemberTitle (_groupId: string, _targetId: string, _title: string): Promise<void> {
    await this.super.setGroupMemberSpecialTitle(+_groupId, +_targetId, _title)
  }

  // ===== 查询 =====
  async getGroupInfo (_groupId: string, _noCache?: boolean): Promise<GroupInfo> {
    const res = await this.super.getGroupInfo(+_groupId, _noCache)
    let admins: GroupInfo['admins'] = []
    try {
      const memberList = (await this.super.getGroupMemberList(+_groupId, _noCache)).members
      admins = memberList
        .filter((m: any) => m.role === 'admin' || m.role === 'owner')
        .map((m: any) => ({ userId: m.user_id + '', name: m.card || m.nickname, role: m.role }))
    } catch {
      // 群成员列表获取失败时忽略 admin 推导
    }
    return {
      groupId: res.group.group_id + '',
      groupName: res.group.group_name,
      maxMemberCount: res.group.max_member_count,
      memberCount: res.group.member_count,
      admins,
      avatar: await this.getGroupAvatarUrl(_groupId, 640 as never),
    } as GroupInfo
  }

  async getGroupList (_refresh?: boolean): Promise<Array<GroupInfo>> {
    const res = (await this.super.getGroupList(_refresh)).groups
    const groups: GroupInfo[] = []
    for (const i of res) {
      groups.push({
        groupId: i.group_id + '',
        groupName: i.group_name,
        maxMemberCount: i.max_member_count,
        memberCount: i.member_count,
        admins: [],
        // qlogo 群头像(与 getGroupAvatarUrl 同规则, 纯拼 URL 无网络开销)
        avatar: `https://p.qlogo.cn/gh/${i.group_id}/${i.group_id}/0`,
      } as GroupInfo)
    }
    return groups
  }

  async getGroupMemberInfo (_groupId: string, _targetId: string, _refresh?: boolean): Promise<GroupMemberInfo> {
    const res = await this.super.getGroupMemberInfo(+_groupId, +_targetId, _refresh)
    return {
      userId: res.member.user_id + '',
      role: res.member.role,
      nick: res.member.nickname,
      age: 0,
      uniqueTitle: res.member.title,
      card: res.member.card,
      joinTime: res.member.join_time,
      lastActiveTime: res.member.last_sent_time,
      level: res.member.level,
      shutUpTime: res.member.shut_up_end_time || undefined,
      sex: res.member.sex,
      sender: {
        userId: res.member.user_id + '',
        nick: res.member.nickname,
        name: res.member.nickname,
        role: res.member.role,
        card: res.member.card,
        level: res.member.level,
        title: res.member.title,
      },
    } as GroupMemberInfo
  }

  async getGroupMemberList (_groupId: string, _refresh?: boolean): Promise<Array<GroupMemberInfo>> {
    const res = (await this.super.getGroupMemberList(+_groupId, _refresh)).members
    const info: GroupMemberInfo[] = []
    for (const i of res) {
      info.push({
        userId: i.user_id + '',
        role: i.role,
        nick: i.nickname,
        age: 0,
        uniqueTitle: i.title,
        card: i.card,
        joinTime: i.join_time,
        lastActiveTime: i.last_sent_time,
        level: i.level,
        shutUpTime: i.shut_up_end_time || undefined,
        sex: i.sex,
        sender: {
          userId: i.user_id + '',
          nick: i.nickname,
          name: i.nickname,
          role: i.role,
          card: i.card,
          level: i.level,
          title: i.title,
        },
      })
    }
    return info
  }

  // ===== 精华 =====
  async getGroupHighlights (_groupId: string, _page: number, _pageSize: number): Promise<Array<GetGroupHighlightsResponse>> {
    const res = (await this.super.getGroupEssenceMessages(+_groupId, _page, _pageSize)).messages
    const list: GetGroupHighlightsResponse[] = []
    for (const i of res) {
      list.push({
        groupId: i.group_id + '',
        senderId: i.sender_id + '',
        senderName: i.sender_name,
        operatorId: i.operator_id + '',
        operatorName: i.operator_name,
        operationTime: i.operation_time,
        messageTime: i.message_time,
        messageId: this.super.encodeMsgId('group', i.sender_id, i.message_seq),
        messageSeq: i.message_seq,
        jsonElements: JSON.stringify(i.segments),
      })
    }
    return list
  }

  async setGroupHighlights (_groupId: string, _messageId: string, _create: boolean): Promise<void> {
    await this.super.setGroupEssenceMessage(+_groupId, this.super.decodeMsgId(_messageId).seq, _create)
  }

  async getStrangerInfo (_targetId: string): Promise<UserInfo> {
    const res = await this.super.getUserProfile(+_targetId)
    return {
      userId: _targetId,
      nick: res.nickname,
      qid: res.qid,
      remark: res.remark,
      level: res.level,
      age: res.age,
      sex: res.sex,
    } as UserInfo
  }

  async getFriendList (_refresh?: boolean): Promise<Array<UserInfo>> {
    const res = (await this.super.getFriendList(_refresh)).friends
    const info: UserInfo[] = []
    for (const i of res) {
      info.push({
        userId: i.user_id + '',
        nick: i.nickname,
        qid: i.qid,
        remark: i.remark,
        sex: i.sex,
      })
    }
    return info
  }

  async sendLike (_targetId: string, _count: number): Promise<void> {
    await this.super.sendProfileLike(+_targetId, _count)
  }

  async getAvatarUrl (_userId: string, _size?: 0 | 40 | 100 | 140): Promise<string> {
    return `https://q1.qlogo.cn/g?b=qq&s=${_size || 0}&nk=${_userId}`
  }

  async getGroupAvatarUrl (_groupId: string, _size?: 0 | 40 | 100 | 140, _history?: number): Promise<string> {
    return `https://p.qlogo.cn/gh/${_groupId}/${_groupId}/${_size}`
  }

  async pokeUser (_contact: Contact, _targetId: string, _count: number = 1): Promise<boolean> {
    let pokeFunc: (() => Promise<void>) | undefined
    if (_contact.scene === 'group') pokeFunc = async () => this.super.sendGroupNudge(+_contact.peer, +_targetId)
    if (_contact.scene === 'friend') pokeFunc = async () => this.super.sendFriendNudge(+_contact.peer, +_targetId === +this.account.selfId)
    if (!pokeFunc) throw new Error('不支持的场景' + _contact.scene)
    for (let i = 0; i < +_count; i++) {
      await pokeFunc()
    }
    return true
  }

  // ===== 审批 =====
  async setFriendApplyResult (_requestId: string, _isApprove: boolean, _remark?: string): Promise<void> {
    let res = (await this.super.getFriendRequests()).requests
    let req = res.find(v => v.initiator_uid === _requestId && v.state === 'pending')
    if (!req) {
      res = (await this.super.getFriendRequests(20, true)).requests
      req = res.find(v => v.initiator_uid === _requestId && v.state === 'pending')
      if (!req) return
    }
    if (_isApprove) {
      await this.super.acceptFriendRequest(req.initiator_uid, req.is_filtered)
    } else {
      await this.super.rejectFriendRequest(req.initiator_uid, req.is_filtered, _remark)
    }
  }

  async setGroupApplyResult (_requestId: string, _isApprove: boolean, _denyReason?: string): Promise<void> {
    const seq = +_requestId
    const found = await findGroupNotification(this.super, seq)
    if (!found) {
      this.logger('warn', `setGroupApplyResult: 未在通知列表中找到 seq=${seq}`)
      return
    }
    const { req, isFiltered } = found
    if (req.type !== 'join_request' && req.type !== 'invited_join_request') return
    if (req.state !== 'pending') return
    if (_isApprove) {
      await this.super.acceptGroupRequest(seq, req.type, req.group_id, isFiltered)
    } else {
      await this.super.rejectGroupRequest(seq, req.type, req.group_id, isFiltered, _denyReason)
    }
  }

  async setInvitedJoinGroupResult (_requestId: string, _isApprove: boolean): Promise<void> {
    const seq = +_requestId
    const groupId = this.invitations.pop(seq)
    if (groupId !== undefined) {
      if (_isApprove) {
        await this.super.acceptGroupInvitation(groupId, seq)
      } else {
        await this.super.rejectGroupInvitation(groupId, seq)
      }
      return
    }
    const found = await findGroupNotification(this.super, seq)
    if (found && found.req.type === 'invited_join_request' && found.req.state === 'pending') {
      const { req, isFiltered } = found
      if (_isApprove) {
        await this.super.acceptGroupRequest(seq, 'invited_join_request', req.group_id, isFiltered)
      } else {
        await this.super.rejectGroupRequest(seq, 'invited_join_request', req.group_id, isFiltered)
      }
      return
    }
    this.logger('warn', `setInvitedJoinGroupResult: 找不到邀请 seq=${seq}(adapter 内存与通知列表均无匹配)`)
  }

  // ===== 文件 =====
  async getFileUrl (contact: Contact, fileId: string): Promise<string> {
    if (contact.scene === 'group') {
      return (await this.super.getGroupFileDownloadUrl(+contact.peer, fileId)).download_url
    }
    // 私聊文件下载需要 file_hash, 事件里拿不到, 用资源临时链接兜底
    return (await this.super.getResourceTempUrl(fileId)).url
  }

  async uploadFile (contact: Contact, file: string, name: string, folder?: string): Promise<void> {
    if (contact.scene === 'group') {
      await this.super.uploadGroupFile(+contact.peer, folder ?? '/', file, name)
    } else {
      await this.super.uploadPrivateFile(+contact.peer, file, name)
    }
  }

  async uploadGroupFile (groupId: string, file: string, name?: string): Promise<boolean> {
    await this.super.uploadGroupFile(+groupId, '/', file, name || '')
    return true
  }

  async delGroupFile (groupId: string, fileId: string): Promise<boolean> {
    await this.super.deleteGroupFile(+groupId, fileId)
    return true
  }

  async getGroupFileList (groupId: string, folderId?: string) {
    const res = await this.super.getGroupFiles(+groupId, folderId ?? '/')
    return {
      files: res.files.map(v => ({
        fid: v.file_id,
        name: v.file_name,
        size: v.file_size,
        uploadTime: v.uploaded_time,
        expireTime: v.expire_time ?? 0,
        modifyTime: v.uploaded_time,
        downloadCount: v.downloaded_times ?? 0,
        uploadId: String(v.uploader_id ?? ''),
        uploadName: '',
        sha1: '',
        sha3: '',
        md5: '',
      })),
      folders: (res.folders || []).map(v => ({
        id: v.folder_id,
        name: v.folder_name,
        fileCount: 0,
        createTime: 0,
        creatorId: '',
        creatorName: '',
      })),
    }
  }

  async createGroupFolder (groupId: string, name: string) {
    const res = await this.super.createGroupFolder(+groupId, name)
    return { id: String(res.folder_id ?? ''), usedSpace: '0' }
  }

  async renameGroupFolder (groupId: string, folderId: string, name: string): Promise<boolean> {
    await this.super.renameGroupFolder(+groupId, folderId, name)
    return true
  }

  async delGroupFolder (groupId: string, folderId: string): Promise<boolean> {
    await this.super.deleteGroupFolder(+groupId, folderId)
    return true
  }

  // ===== 凭证/头像 =====
  async getCookies (_domain: string): Promise<{ cookie: string }> {
    const res = await this.super.getCookies(_domain)
    return { cookie: res.cookies }
  }

  async getCredentials (_domain: string): Promise<{ cookies: string; csrf_token: number }> {
    const cookies = (await this.getCookies(_domain)).cookie
    const token = (await this.getCSRFToken()).token
    return { cookies, csrf_token: token }
  }

  async getCSRFToken (): Promise<{ token: number }> {
    const res = await this.super.getCSRFToken()
    const token = Number(res.csrf_token)
    if (!Number.isFinite(token)) {
      this.logger('warn', `getCSRFToken: 协议端返回 "${res.csrf_token}" 无法转换为 number, 使用 0 兜底`)
      return { token: 0 }
    }
    return { token }
  }

  async setAvatar (uri: string): Promise<void> {
    await this.super.setAvatar(uri)
  }
}

/** milky 协议 bot 工厂 */
export const createMilkyBot = (cfg: BotConfig): MilkyBot | undefined => {
  return new MilkyBot(cfg)
}