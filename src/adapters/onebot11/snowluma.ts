import {
  AdapterConvertKarin,
  KarinConvertAdapter,
  OneBotCreateMessage,
  OneBotCreateNotice,
  OneBotCreateRequest,
  contactFriend,
  logger,
} from 'node-karin'
import { SnowLumaWebSocketClient, node, raw, forward } from '@snowluma/sdk'
import type {
  Contact,
  Elements,
  NodeElement,
  SendMsgResults,
  MessageResponse,
  UserInfo,
  GroupInfo,
  GroupMemberInfo,
  GetGroupHighlightsResponse,
  CreateGroupFolderResponse,
  DownloadFileOptions,
  DownloadFileResponse,
  GetAtAllCountResponse,
  GetAiCharactersResponse,
} from 'node-karin'
/** SDK版本 用作适配器初始版本 */
import snowlumaPkg from '@snowluma/sdk/package.json' with { type: 'json' }
import { createOneBot11Transport } from './transport'
import { OneBot11BaseBot } from './base'
import type { BotConfig } from '../base'

/**
 * SnowLuma 适配器 (OneBot11)
 * 生产为「SDK 专属长连接 + go-cqhttp 兼容层 + NapCat 扩展」的最全实践
 * communication 支持:
 *  - ws(默认): SDK 专属长连接 全部扩展可用
 *  - http / ws-reverse: 走标准 OneBot11 传输层 与 SnowLuma 的 OneBot11 无头接口对接,
 *    扩展方法降级为标准 action 调用(尽力而为)
 */
/** 身份识别关键字 (app_name 匹配用) */
const implKeys = ['snowluma']

export class SnowLumaBot extends OneBot11BaseBot<any> {
  /** 是否 SDK 专属长连接模式 (communication=ws) */
  private readonly sdkMode: boolean

  constructor (cfg: BotConfig) {
    super(cfg)
    const comm = cfg.communication ?? 'ws'
    if (comm === 'ws') {
      // SDK 地址需带协议前缀: 兼容裸地址输入 (如 127.0.0.1:3000)
      const rawUrl = String(cfg.url || '').trim()
      const sdkUrl = /^\w+:\/\//.test(rawUrl) ? rawUrl.replace(/^http/i, 'ws') : `ws://${rawUrl.replace(/^\/+/, '')}`
      this.raw = this.super = new SnowLumaWebSocketClient({
        url: sdkUrl,
        accessToken: cfg.accessToken || undefined,
        reconnect: cfg.reconnect,
      })
      this.sdkMode = true
    } else {
      // HTTP / 反向WS: 标准 OneBot11 传输层
      this.raw = this.super = createOneBot11Transport(cfg)
      this.sdkMode = false
    }
    this.adapter.name = 'SnowLuma'
    this.adapter.version = snowlumaPkg.version
    this.adapter.protocol = 'snowluma'
    this.events()
  }

  /** 执行 OneBot11 action (SDK 模式走原生 raw 否则走标准传输层) */
  protected call (action: string, params?: any) {
    return this.sdkMode ? this.super.raw(action as never, params) : this.super.call(action, params)
  }

  /** 供消息转换器访问文件接口 */
  get _onebot () {
    const raw = this.raw
    return this.sdkMode
      ? { nc_getFile: (fileId: string) => raw.call('get_file', { file_id: fileId } as never) }
      : { nc_getFile: (fileId: string) => this.call('get_file', { file_id: fileId }) }
  }

  /** 绑定事件 SDK 与标准传输的事件 API 不同 */
  private events () {
    const raw: any = this.raw
    const onOpen = () => {
      // 仅当身份校验通过(verified)后才注册: 防止误配 bot 被自动重连后幽灵注册
      if (this.verified) this.register()
      this.adapter.connectTime = Date.now()
    }
    const onClose = () => this.unregister()
    const onMessage = (e: any) => OneBotCreateMessage(e as never, this as never)
    const onNotice = (e: any) => this.handleNotice(e as any, (n) => OneBotCreateNotice(n, this as never))
    const onRequest = (e: any) => OneBotCreateRequest(e as never, this as never)
    if (this.sdkMode) {
      raw.on('open', onOpen)
      raw.on('close', onClose)
      raw.onMessage(onMessage)
      raw.onNotice(onNotice)
      raw.onRequest(onRequest)
      return
    }
    raw.on('open', onOpen)
    raw.on('close', onClose)
    raw.on('error', (e: any) => logger.warn(`[SnowLuma] 连接错误: ${e?.message || e}`))
    raw.on('message', onMessage)
    raw.on('notice', onNotice)
    raw.on('request', onRequest)
  }

  /** 启动 */
  async start () {
    if (!this.raw.isConnected) await this.raw.connect()
    const login: any = this.sdkMode ? await this.raw.getLoginInfo() : await this.call('get_login_info')
    const selfId = String(login.user_id)
    this.account = {
      uin: selfId,
      uid: selfId,
      selfId,
      name: login.nickname || '',
      avatar: await this.getAvatarUrl(selfId),
      subId: {},
    }
    await this.verifyImpl(this.cfg.impl ?? 'snowluma', implKeys)
    // 身份校验通过后才允许注册(含后续重连恢复)
    this.verified = true
    this.register()
  }

  /** 构造转发node段 (SDK 原生段 / 标准段) */
  protected nodes (elements: NodeElement[]): any {
    if (!this.sdkMode) return super.nodes(elements)
    return elements.map((n) => (
      n.subType === 'messageID'
        ? raw('node', { id: n.messageId })
        : node(+n.userId, n.nickname, KarinConvertAdapter(n.message, this as never) as never)
    ))
  }

  // ===== 消息 =====
  async sendMsg (contact: Contact, elements: Elements[]) {
    if (!this.sdkMode) return super.sendMsg(contact, elements)
    const message = KarinConvertAdapter(elements, this as never)
    const id = +contact.peer
    const res = contact.scene === 'group'
      ? await this.raw.sendGroupMessage(id, message as never)
      : await this.raw.sendPrivateMessage(+(contact.scene === 'groupTemp' ? contact.subPeer : contact.peer), message as never)
    const time = Date.now()
    return { messageId: String(res.message_id), message_id: String(res.message_id), time, messageTime: time, rawData: res } as SendMsgResults
  }

  async sendLongMsg (contact: Contact, resId: string) {
    if (!this.sdkMode) return super.sendLongMsg(contact, resId)
    const res = contact.scene === 'group'
      ? await this.raw.sendGroupMessage(+contact.peer, [forward(resId)] as never)
      : await this.raw.sendPrivateMessage(+(contact.scene === 'groupTemp' ? contact.subPeer : contact.peer), [forward(resId)] as never)
    const time = Date.now()
    return { messageId: String(res.message_id), message_id: String(res.message_id), time, messageTime: time, rawData: res } as SendMsgResults
  }

  async sendForwardMsg (contact: Contact, elements: NodeElement[]) {
    if (!this.sdkMode) return super.sendForwardMsg(contact, elements)
    const res = contact.scene === 'group'
      ? await this.raw.sendGroupForwardMessage(+contact.peer, this.nodes(elements) as never)
      : await this.raw.sendPrivateForwardMessage(+contact.peer, this.nodes(elements) as never)
    return { messageId: String(res.message_id), forwardId: String(res.res_id || res.forward_id) }
  }

  async recallMsg (_: Contact, messageId: string) {
    if (!this.sdkMode) return super.recallMsg(_, messageId)
    await this.raw.deleteMessage(+messageId)
  }

  async getMsg (contact: Contact | string, messageId?: string) {
    if (!this.sdkMode) return super.getMsg(contact, messageId)
    const id = typeof contact === 'string' ? contact : messageId!
    const r: any = await this.raw.getMessage(+id)
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
    if (!this.sdkMode) return super.getHistoryMsg(contact, startMsgId, count)
    const res = contact.scene === 'group'
      ? await this.raw.getGroupMessageHistory({ group_id: +contact.peer, message_seq: +startMsgId, count })
      : await this.raw.getFriendMessageHistory({ user_id: +(contact.scene === 'groupTemp' ? contact.subPeer : contact.peer), message_seq: +startMsgId, count })
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
    if (!this.sdkMode) return super.getForwardMsg(resId)
    const res = await this.raw.getForwardMessage({ id: resId })
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
    if (!this.sdkMode) return super.createResId(_, elements)
    const res = await this.raw.uploadForwardMessage({ messages: this.nodes(elements) as never })
    return String(res.res_id)
  }

  async sendApi (action: string, params?: any) { return this.call(action, params) }

  // ===== 群管 =====
  async groupKickMember (gid: string, uid: string, reject = false) {
    if (!this.sdkMode) return super.groupKickMember(gid, uid, reject)
    await this.raw.setGroupKick(+gid, +uid, { rejectAddRequest: reject })
  }
  async setGroupMute (gid: string, uid: string, duration: number) {
    if (!this.sdkMode) return super.setGroupMute(gid, uid, duration)
    await this.raw.setGroupBan(+gid, +uid, duration)
  }
  async setGroupAllMute (gid: string, isBan: boolean) {
    if (!this.sdkMode) return super.setGroupAllMute(gid, isBan)
    await this.raw.setGroupWholeBan(+gid, isBan)
  }
  async setGroupAdmin (gid: string, uid: string, isAdmin: boolean) {
    if (!this.sdkMode) return super.setGroupAdmin(gid, uid, isAdmin)
    await this.raw.setGroupAdmin(+gid, +uid, isAdmin)
  }
  async setGroupMemberCard (gid: string, uid: string, card: string) {
    if (!this.sdkMode) return super.setGroupMemberCard(gid, uid, card)
    await this.raw.setGroupCard(+gid, +uid, card)
  }
  async setGroupName (gid: string, name: string) {
    if (!this.sdkMode) return super.setGroupName(gid, name)
    await this.raw.setGroupName(+gid, name)
  }
  async setGroupQuit (gid: string, _: boolean) {
    if (!this.sdkMode) return super.setGroupQuit(gid, _)
    await this.raw.setGroupLeave(+gid)
  }
  async setGroupMemberTitle (gid: string, uid: string, title: string) {
    if (!this.sdkMode) return super.setGroupMemberTitle(gid, uid, title)
    await this.raw.setGroupSpecialTitle(+gid, +uid, title)
  }
  async setGroupRemark (gid: string, remark: string) {
    if (!this.sdkMode) return super.setGroupRemark(gid, remark)
    await this.super.call('set_group_remark', { group_id: +gid, remark } as never)
    return true
  }

  // ===== 查询 =====
  async getStrangerInfo (targetId: string) {
    if (!this.sdkMode) return super.getStrangerInfo(targetId)
    const r: any = await this.raw.getStrangerInfo(+targetId)
    return { userId: targetId, uid: r.uid || targetId, uin: targetId, nick: r.nickname || '', name: r.nickname || '', sex: r.sex || 'unknown', age: r.age || 0, qid: r.qid || '' } as UserInfo
  }

  async getFriendList () {
    if (!this.sdkMode) return super.getFriendList()
    const list: any[] = await this.raw.getFriendList()
    return list.map((v) => ({ userId: String(v.user_id ?? ''), uid: '', uin: String(v.user_id ?? ''), nick: v.nickname || '', name: v.nickname || '', remark: v.remark || '' })) as UserInfo[]
  }

  async getGroupInfo (groupId: string, noCache = false) {
    if (!this.sdkMode) return super.getGroupInfo(groupId, noCache)
    const r: any = await this.raw.getGroupInfo(+groupId, { noCache })
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
    if (!this.sdkMode) return super.getGroupList()
    const list: any[] = await this.raw.getGroupList()
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
    if (!this.sdkMode) return super.getGroupMemberInfo(groupId, targetId, refresh)
    const r: any = await this.raw.getGroupMemberInfo(+groupId, +targetId, { noCache: refresh })
    return {
      userId: targetId, uid: targetId, uin: targetId, nick: r.nickname || '', name: r.nickname || '',
      role: r.role || 'member', age: r.age || 0, card: r.card || '', uniqueTitle: r.title || '',
      joinTime: r.join_time || 0, lastActiveTime: r.last_sent_time || 0, level: Number(r.level) || 0, sex: r.sex || 'unknown',
    } as unknown as GroupMemberInfo
  }

  async getGroupMemberList (groupId: string, refresh = false) {
    if (!this.sdkMode) return super.getGroupMemberList(groupId, refresh)
    const list: any[] = await this.raw.getGroupMemberList(+groupId, { noCache: refresh })
    return list.map((v) => {
      const userId = String(v.user_id ?? '')
      return {
        userId, uid: userId, uin: userId, nick: v.nickname || '', name: v.nickname || '', role: v.role || 'member',
        age: v.age || 0, card: v.card || '', uniqueTitle: v.title || '', joinTime: v.join_time || 0,
        lastActiveTime: v.last_sent_time || 0, level: Number(v.level) || 0, sex: v.sex || 'unknown',
      } as unknown as GroupMemberInfo
    })
  }

  async getNotJoinedGroupInfo (groupId: string) {
    if (this.sdkMode) {
      const r: any = await this.raw.getGroupInfoEx(+groupId)
      return { groupId, groupName: r.group_name || '', owner: String(r.owner_id ?? ''), maxMemberCount: r.max_member_count || 0, memberCount: r.member_count || 0, admins: [] } as GroupInfo
    }
    const r: any = await this.call('get_group_info', { group_id: +groupId })
    return { groupId, groupName: r.group_name || '', owner: String(r.owner_id ?? ''), maxMemberCount: r.max_member_count || 0, memberCount: r.member_count || 0, admins: [] } as GroupInfo
  }
  async getGroupMuteList (groupId: string) {
    if (!this.sdkMode) return super.getGroupMuteList(groupId)
    const list: any[] = await this.super.call('get_group_shut_list', { group_id: +groupId } as never)
    return (list || []).map((v) => ({ userId: String(v.user_id ?? ''), muteTime: v.shut_time ?? v.mute_time ?? 0 }))
  }
  async getAtAllCount (groupId: string) {
    if (!this.sdkMode) return super.getAtAllCount(groupId)
    const r: any = await this.super.call('get_at_all_count', { group_id: +groupId, no_cache: true } as never)
    return {
      accessAtAll: r.can_at_all ?? r.access_at_all ?? false,
      groupRemainCount: r.remain_times ?? r.group_remain_count ?? 0,
      userRremainCount: r.remain_times_for_me ?? r.user_remain_count ?? 0,
    } as GetAtAllCountResponse
  }

  // ===== 精华 =====
  async getGroupHighlights (groupId: string, _: number, __: number) {
    if (!this.sdkMode) return super.getGroupHighlights(groupId, _, __)
    const res: any[] = await this.raw.getEssenceMessageList(+groupId)
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
    if (!this.sdkMode) return super.setGroupHighlights(_, messageId, create)
    create ? await this.raw.setEssenceMessage(+messageId) : await this.raw.deleteEssenceMessage(+messageId)
  }

  // ===== 审批 =====
  async setFriendApplyResult (requestId: string, isApprove: boolean, remark?: string) {
    if (!this.sdkMode) return super.setFriendApplyResult(requestId, isApprove, remark)
    await this.super.call('set_friend_add_request', { flag: requestId, approve: isApprove, remark } as never)
  }
  async setGroupApplyResult (requestId: string, isApprove: boolean, denyReason?: string) {
    if (!this.sdkMode) return super.setGroupApplyResult(requestId, isApprove, denyReason)
    await this.raw.setGroupAddRequest(requestId, { approve: isApprove, subType: 'add', reason: denyReason })
  }
  async setInvitedJoinGroupResult (requestId: string, isApprove: boolean) {
    if (!this.sdkMode) return super.setInvitedJoinGroupResult(requestId, isApprove)
    await this.raw.setGroupAddRequest(requestId, { approve: isApprove, subType: 'invite' })
  }

  // ===== 互动 =====
  async sendLike (targetId: string, count: number) {
    if (!this.sdkMode) return super.sendLike(targetId, count)
    await this.raw.sendLike(+targetId, count)
  }
  async pokeUser (contact: Contact, targetId: string, count = 1) {
    if (!this.sdkMode) return super.pokeUser(contact, targetId, count)
    for (let i = 0; i < count; i++) {
      if (contact.scene === 'group') await this.raw.groupPoke(+contact.peer, +targetId)
      else await this.raw.friendPoke(+targetId)
    }
    return true
  }
  async setMsgReaction (_: Contact, messageId: string, faceId: number | string, isSet: boolean) {
    if (!this.sdkMode) return super.setMsgReaction(_, messageId, faceId, isSet)
    await this.raw.setMsgEmojiLike(+messageId, String(faceId), isSet)
  }

  // ===== 文件 =====
  async uploadFile (contact: Contact, file: string, name: string, folder?: string) {
    if (!this.sdkMode) {
      if (contact.scene === 'group') await this.call('upload_group_file', { group_id: +contact.peer, file, name, folder })
      else await this.call('upload_private_file', { user_id: +(contact.scene === 'groupTemp' ? contact.subPeer : contact.peer), file, name })
      return
    }
    if (contact.scene === 'group') await this.raw.uploadGroupFile(+contact.peer, file, { name, folder })
    else await this.raw.uploadPrivateFile(+contact.peer, file, { name })
  }
  async getFileUrl (contact: Contact, fileId: string) {
    if (!this.sdkMode) {
      const r: any = contact.scene === 'group'
        ? await this.call('get_group_file_url', { group_id: +contact.peer, file_id: fileId })
        : await this.call('get_private_file_url', { user_id: +(contact.scene === 'groupTemp' ? contact.subPeer : contact.peer), file_id: fileId })
      return r?.url ?? ''
    }
    const { url } = contact.scene === 'group'
      ? await this.raw.getGroupFileUrl(+contact.peer, fileId)
      : await this.raw.getPrivateFileUrl(+contact.peer, fileId, '')
    return url
  }
  async downloadFile (options: DownloadFileOptions) {
    if (!this.sdkMode) {
      const r: any = await this.call('download_file', {
        url: (options as any).url,
        base64: (options as any).base64,
        name: options.fileName,
        headers: options.headers,
      })
      return { filePath: r?.file ?? '' } as DownloadFileResponse
    }
    const r = await this.raw.downloadFile({ url: (options as any).url, base64: (options as any).base64, name: options.fileName, headers: options.headers })
    return { filePath: r.file } as DownloadFileResponse
  }
  async uploadGroupFile (groupId: string, file: string, name?: string) {
    if (!this.sdkMode) {
      await this.call('upload_group_file', { group_id: +groupId, file, name })
      return true
    }
    await this.raw.uploadGroupFile(+groupId, file, { name })
    return true
  }
  async delGroupFile (groupId: string, fileId: string, busId: number) {
    if (!this.sdkMode) {
      await this.call('delete_group_file', { group_id: +groupId, file_id: fileId, bus_id: busId })
      return true
    }
    await this.super.call('delete_group_file', { group_id: +groupId, file_id: fileId, bus_id: busId } as never)
    return true
  }
  async getGroupFileSystemInfo (groupId: string) {
    if (!this.sdkMode) {
      const r: any = await this.call('get_group_file_system_info', { group_id: +groupId })
      return { ...r, fileCount: r.file_count, limitCount: r.limit_count, usedSpace: r.used_space, totalSpace: r.total_space } as any
    }
    const r = await this.raw.getGroupFileSystemInfo(+groupId)
    return { ...r, fileCount: r.file_count, limitCount: r.limit_count, usedSpace: r.used_space, totalSpace: r.total_space } as any
  }
  async getGroupFileList (groupId: string, folderId?: string) {
    if (!this.sdkMode) {
      const r: any = folderId
        ? await this.call('get_group_files_by_folder', { group_id: +groupId, folder_id: folderId })
        : await this.call('get_group_root_files', { group_id: +groupId })
      return {
        files: (r.files || []).map((v: any) => ({
          fid: v.file_id,
          name: v.file_name,
          size: v.file_size,
          uploadTime: v.upload_time,
          expireTime: v.dead_time,
          modifyTime: v.modify_time,
          downloadCount: v.download_times,
          uploadId: String(v.uploader ?? ''),
          uploadName: v.uploader_name || '',
          sha1: '',
          sha3: '',
          md5: '',
        })),
        folders: (r.folders || []).map((v: any) => ({
          id: v.folder_id,
          name: v.folder_name,
          fileCount: v.total_file_count,
          createTime: v.create_time,
          creatorId: String(v.creator ?? ''),
          creatorName: v.creator_name || '',
        })),
      }
    }
    const r: any = folderId ? await this.raw.getGroupFilesByFolder(+groupId, folderId) : await this.raw.getGroupRootFiles(+groupId)
    return {
      files: (r.files || []).map((v: any) => ({
        fid: v.file_id,
        name: v.file_name,
        size: v.file_size,
        uploadTime: v.upload_time,
        expireTime: v.dead_time,
        modifyTime: v.modify_time,
        downloadCount: v.download_times,
        uploadId: String(v.uploader ?? ''),
        uploadName: v.uploader_name || '',
        sha1: '',
        sha3: '',
        md5: '',
      })),
      folders: (r.folders || []).map((v: any) => ({
        id: v.folder_id,
        name: v.folder_name,
        fileCount: v.total_file_count,
        createTime: v.create_time,
        creatorId: String(v.creator ?? ''),
        creatorName: v.creator_name || '',
      })),
    }
  }
  async createGroupFolder (groupId: string, name: string) {
    if (!this.sdkMode) {
      const r: any = await this.call('create_group_folder', { group_id: +groupId, name })
      return { id: String(r?.folder_id ?? r?.id ?? ''), usedSpace: String(r?.used_space ?? '') } as CreateGroupFolderResponse
    }
    const r: any = await this.raw.createGroupFileFolder(+groupId, name)
    return { id: String(r?.folder_id ?? r?.id ?? ''), usedSpace: String(r?.used_space ?? '') } as CreateGroupFolderResponse
  }
  async renameGroupFolder (groupId: string, folderId: string, name: string) {
    if (!this.sdkMode) {
      await this.call('rename_group_folder', { group_id: +groupId, folder_id: folderId, name })
      return true
    }
    await this.raw.renameGroupFileFolder(+groupId, folderId, name)
    return true
  }
  async delGroupFolder (groupId: string, folderId: string) {
    if (!this.sdkMode) {
      await this.call('delete_group_folder', { group_id: +groupId, folder_id: folderId })
      return true
    }
    await this.raw.deleteGroupFileFolder(+groupId, folderId)
    return true
  }

  // ===== 凭证/头像 =====
  async getCookies (domain: string) {
    if (!this.sdkMode) {
      const r: any = await this.call('get_cookies', { domain })
      return { cookie: r?.cookie ?? r?.cookies ?? '' }
    }
    return { cookie: (await this.raw.getCookies({ domain })).cookies }
  }
  async getCredentials (domain: string) {
    if (!this.sdkMode) {
      const r: any = await this.call('get_credentials', { domain })
      return { cookies: r?.cookies ?? r?.cookie ?? '', csrf_token: r?.csrf_token ?? r?.token ?? '' }
    }
    const r = await this.raw.getCredentials({ domain })
    return { cookies: r.cookies, csrf_token: r.token ?? r.csrf_token }
  }
  async getCSRFToken () {
    if (!this.sdkMode) {
      const r: any = await this.call('get_csrf_token')
      return { token: r?.token ?? r?.csrf_token ?? '' }
    }
    return { token: (await this.raw.getCsrfToken()).token }
  }
  async getRkey () {
    if (!this.sdkMode) {
      const r: any = await this.call('nc_get_rkey')
      return Array.isArray(r) ? r : (r?.rkeys || [])
    }
    const r: any = await this.raw.getRKey()
    return Array.isArray(r) ? r : (r.rkeys || [])
  }
  async setAvatar (file: string) {
    if (this.sdkMode) await this.super.call('set_qq_avatar', { file } as never)
    else await this.call('set_qq_avatar', { file })
  }

  // ===== AI语音 =====
  async getAiCharacters () {
    if (!this.sdkMode) {
      const list: any[] = await this.call('get_ai_characters', {})
      return (list || []).map((v) => ({
        character_id: v.character_id ?? '',
        character_name: v.character_name || '',
        preview_url: v.preview_url || '',
      })) as GetAiCharactersResponse[]
    }
    const list: any[] = await this.super.call('get_ai_characters', {} as never)
    return (list || []).map((v) => ({
      character_id: v.character_id ?? '',
      character_name: v.character_name || '',
      preview_url: v.preview_url || '',
    })) as GetAiCharactersResponse[]
  }
  async sendAiCharacter (groupId: string, character: string, text: string) {
    if (!this.sdkMode) {
      const r: any = await this.call('send_ai_character', { group_id: +groupId, character_id: character, text })
      return { messageId: String(r?.message_id ?? '') }
    }
    const r: any = await this.super.call('send_ai_character', { group_id: +groupId, character_id: character, text } as never)
    return { messageId: String(r?.message_id ?? '') }
  }
}