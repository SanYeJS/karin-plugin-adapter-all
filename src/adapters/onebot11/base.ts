import {
  AdapterConvertKarin,
  KarinConvertAdapter,
  OneBotCreateMessage,
  OneBotCreateNotice,
  OneBotCreateRequest,
  contactFriend,
  logger,
} from 'node-karin'
import type {
  Contact,
  Elements,
  NodeElement,
  SendMsgResults,
  MessageResponse,
  UserInfo,
  GroupInfo,
  GroupMemberInfo,
  QQGroupHonorInfo,
  GetGroupHighlightsResponse,
  GetAtAllCountResponse,
} from 'node-karin'
import { BaseBot } from '../base'
import type { BotConfig, OneBot11Impl } from '../base'

/** Karin支持的标准通知类型 */
const knownTypes = new Set([
  'group_upload', 'group_admin', 'group_decrease', 'group_increase', 'group_ban',
  'friend_add', 'group_recall', 'friend_recall', 'notify',
  'group_msg_emoji_like', 'reaction', 'essence', 'group_card', 'offline_file', 'bot_offline',
])
/** notify支持的子类型 */
const knownNotify = new Set(['poke', 'lucky_king', 'honor'])
/** 荣誉名映射 */
const honors: Record<string, string> = {
  talkative_list: '龙王',
  performer_list: '群聊之火',
  legend_list: '群聊炽焰',
  strong_newbie_list: '冒尖小春笋',
  emotion_list: '快乐之源',
}

/**
 * Data URL 统一转 `base64://` scheme (兜底归一化转换结果)。
 * node-karin 的 OneBot11 转换器对 data: URL 原样透传, 而各实现的 file 字段
 * 仅支持 http(s):// file:// base64:// 三种格式, 故发送前将
 * `data:image/png;base64,xxx` 重写为 `base64://xxx`
 */
export const normalizeDataUrl = (message: any[]): any[] => message.map((seg: any) => {
  const file = seg?.data?.file
  if (typeof file !== 'string' || !file.startsWith('data:')) return seg
  const match = /^data:[^;,]*;base64,(.+)$/s.exec(file)
  return match ? { ...seg, data: { ...seg.data, file: `base64://${match[1]}` } } : seg
})

/**
 * OneBot11 共享基类
 * 三端相同的部分: 连接元信息、事件白名单、QQ头像URL、OneBot11 标准 API
 * 差异集中在扩展API → 各实现单独文件
 *
 * 子类需实现:
 *  - call: 执行 OneBot11 action (SnowLuma 走 SDK, NapCat/Lagrange 走 WS)
 *  - start: 建立连接并注册
 */
export abstract class OneBot11BaseBot<T = any> extends BaseBot<T> {
  constructor (readonly cfg: BotConfig) {
    super(cfg)
    this.adapter.platform = 'qq'
    this.adapter.standard = 'onebot11'
    // 通信方式: ws(正向)/ws-reverse(反向)/http/sse 缺省为正向 ws
    // 正向 = 本端作为服务端监听, 反向 = 本端作为客户端连接
    const comm = cfg.communication || 'ws'
    this.adapter.communication = comm === 'http'
      ? 'http'
      : (comm === 'ws'
        ? 'webSocketServer'
        : (comm === 'sse' ? 'sse' : 'webSocketClient'))
    this.adapter.connectTime = 0
  }

  /**
   * 身份校验是否通过
   * open 事件仅在通过校验后才会注册, 防止: 服务端实现与配置不符时,
   * verifyImpl 抛错 → stop → 底层 SDK/WS 自动重连 → open 又无条件注册 的误配 bot 幽灵注册
   */
  protected verified = false

  /** 执行 OneBot11 action */
  protected abstract call (action: string, params?: any): Promise<any>

  /**
   * 通知事件白名单过滤
   * Karin不支持的扩展通知降为debug输出，避免刷屏
   */
  protected handleNotice (n: any, callback: (notice: any) => void) {
    if (!knownTypes.has(n.notice_type) || (n.notice_type === 'notify' && !knownNotify.has(n.sub_type))) {
      logger.debug(`[OneBot11] 忽略扩展通知: ${JSON.stringify(n)}`)
      return
    }
    callback(n)
  }

  /**
   * 连接后探测服务端实现身份并补全 adapter.version (get_version_info.app_version)
   * keys: 本实现 app_name 中的识别关键字, 由子类自持
   * 子类在 start() 中完成登录后调用
   * 仅用于补全版本信息, 不做硬校验: 平台识别由「标准 OneBot11」实现负责
   */
  protected async verifyImpl (expected: OneBot11Impl, keys: string[]) {
    let info: any = {}
    try {
      info = await this.call('get_version_info')
    } catch {
      /* 探测失败不阻塞启动 */
    }
    const appName = String(info.app_name ?? '').toLowerCase()
    const appVersion = String(info.app_version ?? info.version ?? '')
    if (appVersion) this.adapter.version = appVersion
    const matches = keys.some((k) => appName.includes(k))
    if (matches && appName) {
      logger.info(`[OneBot11/${expected}] 身份匹配: ${appName} v${appVersion || '-'} @ ${this.adapter.address}`)
    }
  }

  /** QQ头像URL */
  async getAvatarUrl (userId: string, size: 0 | 40 | 100 | 140 = 0) {
    return Number(userId) ? `https://q1.qlogo.cn/g?b=qq&s=${size}&nk=${userId}` : `https://q.qlogo.cn/qqapp/${userId}/${userId}/${size}`
  }

  /** 群头像URL */
  async getGroupAvatarUrl (groupId: string, size: 0 | 40 | 100 | 140 = 0, history = 0) {
    return `https://p.qlogo.cn/gh/${groupId}/${groupId}${history ? '_' + history : ''}/` + size
  }

  /** 构造转发node段 (OneBot11 标准) */
  protected nodes (elements: NodeElement[]): any {
    return elements.map((n) => ({
      type: 'node',
      data: n.subType === 'messageID'
        ? { id: n.messageId }
        : { name: n.nickname, uin: String(n.userId), content: normalizeDataUrl(KarinConvertAdapter(n.message, this as never)) },
    }))
  }

  // ===== 消息 =====
  async sendMsg (contact: Contact, elements: Elements[]) {
    const message = normalizeDataUrl(KarinConvertAdapter(elements, this as never))
    const params: any = contact.scene === 'group'
      ? { group_id: +contact.peer }
      : { user_id: +(contact.scene === 'groupTemp' ? contact.subPeer : contact.peer) }
    const res = await this.call('send_msg', { message_type: contact.scene === 'group' ? 'group' : 'private', ...params, message })
    const time = Date.now()
    return { messageId: String(res.message_id), message_id: String(res.message_id), time, messageTime: time, rawData: res } as SendMsgResults
  }

  async sendLongMsg (contact: Contact, resId: string) {
    return this.sendMsg(contact, [{ type: 'forward', data: { id: resId } }] as unknown as Elements[])
  }

  async sendForwardMsg (contact: Contact, elements: NodeElement[]) {
    const params: any = contact.scene === 'group'
      ? { group_id: +contact.peer }
      : { user_id: +(contact.scene === 'groupTemp' ? contact.subPeer : contact.peer) }
    const res = await this.call('send_forward_msg', { message_type: contact.scene === 'group' ? 'group' : 'private', ...params, messages: this.nodes(elements) })
    return { messageId: String(res.message_id), forwardId: String(res.forward_id ?? '') }
  }

  async recallMsg (_: Contact, messageId: string) {
    await this.call('delete_msg', { message_id: +messageId })
  }

  async getMsg (contact: Contact | string, messageId?: string) {
    const id = typeof contact === 'string' ? contact : messageId!
    const r: any = await this.call('get_msg', { message_id: +id })
    const isGroup = r.message_type === 'group'
    const userId = String(r.user_id ?? r.sender?.user_id ?? '')
    const nick = r.sender?.nickname || ''
    const c: Contact = typeof contact === 'object'
      ? contact
      : (isGroup
        ? { scene: 'group', peer: String(r.group_id ?? userId), name: nick } as any
        : contactFriend(String(r.user_id ?? userId)))
    return {
      time: r.time || 0,
      messageId: id,
      messageSeq: r.message_seq || r.message_id || 0,
      contact: c,
      sender: { userId, uid: userId, uin: r.user_id, nick, name: nick, role: r.sender?.role || 'member', sex: r.sender?.sex || 'unknown' } as any,
      elements: await AdapterConvertKarin(r.message || [], this as never),
    } as MessageResponse
  }

  async getHistoryMsg (contact: Contact, startMsgId: string | number, count: number) {
    const res = contact.scene === 'group'
      ? await this.call('get_group_msg_history', { group_id: +contact.peer, message_seq: +startMsgId, count })
      : await this.call('get_friend_msg_history', { user_id: +(contact.scene === 'groupTemp' ? contact.subPeer : contact.peer), message_seq: +startMsgId, count })
    return Promise.all((res.messages as any[]).map(async (v) => ({
      time: v.time || 0,
      messageId: String(v.message_id ?? ''),
      messageSeq: v.message_seq || v.message_id || 0,
      contact,
      sender: { userId: String(v.user_id ?? ''), nick: v.sender?.nickname || '', name: v.sender?.nickname || '', role: v.sender?.role || 'member' } as any,
      elements: await AdapterConvertKarin(v.message || [], this as never),
    })))
  }

  async getForwardMsg (resId: string) {
    const res: any = await this.call('get_forward_msg', { id: resId })
    return Promise.all((res.messages as any[]).map(async (v) => ({
      time: v.time || 0,
      messageId: String(v.message_id ?? ''),
      messageSeq: v.message_seq || v.message_id || 0,
      contact: { scene: 'friend' as const, peer: String(v.user_id ?? ''), name: v.nickname || '' },
      sender: { userId: String(v.user_id ?? ''), nick: v.nickname || '', name: v.nickname || '', role: 'member' } as any,
      elements: await AdapterConvertKarin(v.message || v.content || [], this as never),
    })))
  }

  async createResId (_: Contact, elements: NodeElement[]) {
    const res: any = await this.call('upload_forward_msg', { messages: this.nodes(elements) })
    return String(res.res_id)
  }

  async sendApi (action: string, params?: any) { return this.call(action, params) }

  // ===== 群管 =====
  async groupKickMember (gid: string, uid: string, reject = false) {
    await this.call('set_group_kick', { group_id: +gid, user_id: +uid, reject_add_request: reject })
  }
  async setGroupMute (gid: string, uid: string, duration: number) {
    await this.call('set_group_ban', { group_id: +gid, user_id: +uid, duration })
  }
  async setGroupAllMute (gid: string, isBan: boolean) {
    await this.call('set_group_whole_ban', { group_id: +gid, enable: isBan })
  }
  async setGroupAdmin (gid: string, uid: string, isAdmin: boolean) {
    await this.call('set_group_admin', { group_id: +gid, user_id: +uid, enable: isAdmin })
  }
  async setGroupMemberCard (gid: string, uid: string, card: string) {
    await this.call('set_group_card', { group_id: +gid, user_id: +uid, card })
  }
  async setGroupName (gid: string, name: string) {
    await this.call('set_group_name', { group_id: +gid, group_name: name })
  }
  async setGroupQuit (gid: string, _: boolean) {
    await this.call('set_group_leave', { group_id: +gid })
  }
  async setGroupMemberTitle (gid: string, uid: string, title: string) {
    await this.call('set_group_special_title', { group_id: +gid, user_id: +uid, special_title: title })
  }
  async setGroupRemark (gid: string, remark: string) {
    await this.call('set_group_remark', { group_id: +gid, remark })
    return true
  }

  // ===== 查询 =====
  async getStrangerInfo (targetId: string) {
    const r: any = await this.call('get_stranger_info', { user_id: +targetId, no_cache: false })
    return { userId: targetId, uid: r.uid || targetId, uin: targetId, nick: r.nickname || '', name: r.nickname || '', sex: r.sex || 'unknown', age: r.age || 0, qid: r.qid || '' } as UserInfo
  }

  async getFriendList () {
    const list: any[] = await this.call('get_friend_list')
    return list.map((v) => ({ userId: String(v.user_id ?? ''), uid: '', uin: String(v.user_id ?? ''), nick: v.nickname || '', name: v.nickname || '', remark: v.remark || '' })) as UserInfo[]
  }

  async getGroupInfo (groupId: string, noCache = false) {
    const r: any = await this.call('get_group_info', { group_id: +groupId, no_cache: noCache })
    return {
      groupId,
      groupName: r.group_name || '',
      owner: String(r.owner_id ?? ''),
      maxMemberCount: r.max_member_count || 0,
      memberCount: r.member_count || 0,
      admins: (r.admin_list || []).map((v: any) => ({ userId: String(v.user_id ?? ''), name: v.nickname || '', role: v.role || 'member' })),
      avatar: await this.getGroupAvatarUrl(groupId),
    } as GroupInfo
  }

  async getGroupList () {
    const list: any[] = await this.call('get_group_list')
    return Promise.all(list.map(async (v) => {
      const groupId = String(v.group_id ?? '')
      return {
        groupId,
        groupName: v.group_name || '',
        owner: String(v.owner_id ?? ''),
        maxMemberCount: v.max_member_count || 0,
        memberCount: v.member_count || 0,
        admins: [],
        avatar: await this.getGroupAvatarUrl(groupId),
      } as GroupInfo
    }))
  }

  async getGroupMemberInfo (groupId: string, targetId: string, refresh = false) {
    const r: any = await this.call('get_group_member_info', { group_id: +groupId, user_id: +targetId, no_cache: refresh })
    return {
      userId: targetId, uid: targetId, uin: targetId, nick: r.nickname || '', name: r.nickname || '',
      role: r.role || 'member', age: r.age || 0, card: r.card || '', uniqueTitle: r.title || '',
      joinTime: r.join_time || 0, lastActiveTime: r.last_sent_time || 0, level: Number(r.level) || 0, sex: r.sex || 'unknown',
    } as unknown as GroupMemberInfo
  }

  async getGroupMemberList (groupId: string, refresh = false) {
    const list: any[] = await this.call('get_group_member_list', { group_id: +groupId, no_cache: refresh })
    return list.map((v) => {
      const userId = String(v.user_id ?? '')
      return {
        userId, uid: userId, uin: userId, nick: v.nickname || '', name: v.nickname || '', role: v.role || 'member',
        age: v.age || 0, card: v.card || '', uniqueTitle: v.title || '', joinTime: v.join_time || 0,
        lastActiveTime: v.last_sent_time || 0, level: Number(v.level) || 0, sex: v.sex || 'unknown',
      } as unknown as GroupMemberInfo
    })
  }

  async getGroupHonor (groupId: string) {
    const r: any = await this.call('get_group_honor_info', { group_id: +groupId, type: 'all' })
    const list: QQGroupHonorInfo[] = []
    for (const [key, name] of Object.entries(honors)) {
      for (const h of (r[key] || [])) {
        list.push({ userId: String(h.user_id ?? ''), nick: h.nickname || '', honorName: name, avatar: h.avatar || '', id: 0, description: h.description || '' })
      }
    }
    return list
  }

  async getGroupMuteList (groupId: string) {
    const list: any[] = await this.call('get_group_shut_list', { group_id: +groupId })
    return (list || []).map((v) => ({ userId: String(v.user_id ?? ''), muteTime: v.shut_time ?? v.mute_time ?? 0 }))
  }

  async getAtAllCount (groupId: string) {
    const r: any = await this.call('get_at_all_count', { group_id: +groupId, no_cache: true })
    return {
      accessAtAll: r.can_at_all ?? r.access_at_all ?? false,
      groupRemainCount: r.remain_times ?? r.group_remain_count ?? 0,
      userRremainCount: r.remain_times_for_me ?? r.user_remain_count ?? 0,
    } as GetAtAllCountResponse
  }

  // ===== 精华 =====
  async getGroupHighlights (groupId: string, _: number, __: number) {
    const res: any[] = await this.call('get_essence_msg_list', { group_id: +groupId })
    return res.map((v) => ({
      groupId,
      senderId: String(v.sender_id ?? ''),
      senderName: v.sender_nick || '',
      operatorId: String(v.operator_id ?? ''),
      operatorName: v.operator_nick || '',
      operationTime: v.operator_time || 0,
      messageTime: v.sender_time || 0,
      messageId: String(v.message_id ?? ''),
      messageSeq: v.message_seq || 0,
      jsonElements: JSON.stringify(v.message || []),
    })) as GetGroupHighlightsResponse[]
  }

  async setGroupHighlights (_: string, messageId: string, create: boolean) {
    create ? await this.call('set_essence_msg', { message_id: +messageId }) : await this.call('delete_essence_msg', { message_id: +messageId })
  }

  // ===== 审批 =====
  async setFriendApplyResult (requestId: string, isApprove: boolean, remark?: string) {
    await this.call('set_friend_add_request', { flag: requestId, approve: isApprove, remark })
  }
  async setGroupApplyResult (requestId: string, isApprove: boolean, denyReason?: string) {
    await this.call('set_group_add_request', { flag: requestId, approve: isApprove, reason: denyReason, sub_type: 'add' })
  }
  async setInvitedJoinGroupResult (requestId: string, isApprove: boolean) {
    await this.call('set_group_add_request', { flag: requestId, approve: isApprove, sub_type: 'invite' })
  }

  // ===== 互动 =====
  async sendLike (targetId: string, count: number) {
    await this.call('send_like', { user_id: +targetId, times: count })
  }
  /** poke 为 OneBot11 扩展 action (NapCat/Lagrange 均支持) */
  async pokeUser (contact: Contact, targetId: string, count = 1) {
    for (let i = 0; i < count; i++) {
      await this.call('poke', contact.scene === 'group'
        ? { user_id: +targetId, group_id: +contact.peer }
        : { user_id: +targetId })
    }
    return true
  }
  /** 表情回应为扩展 action (OneBot11下各实现行为一致) */
  async setMsgReaction (_: Contact, messageId: string, faceId: number | string, isSet: boolean) {
    await this.call('set_msg_emoji_like', { message_id: +messageId, emoji_id: +faceId, set: isSet })
  }

  /** 启动并注册 */
  abstract start (): Promise<void>
}