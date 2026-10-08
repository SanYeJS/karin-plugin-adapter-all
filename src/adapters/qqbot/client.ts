import axios, { AxiosInstance } from 'node-karin/axios'
import type { BotConfig } from '../base'

/** QQBot API 统一响应包装 */
type QqBotResponse<T = unknown> = {
  code: number
  message: string
  data: T
}

/** QQBot 用户信息 */
export type QqBotUser = {
  id: string
  username: string
  avatar: string
}

/** QQBot 频道信息 */
export type QqBotGuild = {
  id: string
  name: string
  icon: string
  owner_id?: string
  member_count?: number
  max_members?: number
}

/** QQBot 已上传媒体文件信息 */
export type QqBotFileInfo = {
  file_info: string
  ttl: number
}

/** QQBot 频道信息 */
export type QqBotChannel = {
  id: string
  guild_id: string
  name: string
  type: number
  parent_id?: string
  owner_id?: string
}

/** QQBot 频道成员 */
export type QqBotMember = {
  user: { id: string; username?: string; avatar?: string }
  nick?: string
  roles?: string[]
  joined_at?: string
}

/** QQBot 频道身份组 */
export type QqBotRole = {
  id: string
  name: string
  color: number
  hoist: boolean
  number: number
  member_limit: string
}

/**
 * QQ 开放平台(QQBot)官方 API 客户端 (api-v2)。
 * base https://api.bot.qq.com
 * 鉴权: 通过官方 AccessToken 接口换取凭证, `Authorization: QQBot {token}` (token 缓存, 过期前 60s 提前刷新)。
 * 响应统一 { code, message, data }, code !== 0 时抛错。
 */
export class Client {
  #axios: AxiosInstance
  /** 独立鉴权实例: 不带自身 request interceptor, 防止换取 token 时递归触发 */
  #authAxios: AxiosInstance
  /** AppID (头像拼接用) */
  readonly appId: string
  /** 官方接入票据 AppSecret (开放平台「开发设置」获取) */
  readonly clientSecret: string
  /** 缓存的 AccessToken */
  #authToken: { token: string; expireAt: number } | null = null

  constructor (cfg: BotConfig) {
    this.appId = cfg.qqbotAppId || ''
    this.clientSecret = cfg.qqbotClientSecret || ''
    const baseURL = 'https://api.bot.qq.com'
    this.#axios = axios.create({
      baseURL,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      timeout: cfg.requestTimeout || 15000,
    })
    // 独立实例专用于换取 AccessToken (不带自身 interceptor; 业务 API 与鉴权端点均属 api.bot.qq.com)
    this.#authAxios = axios.create({
      baseURL: 'https://api.bot.qq.com',
      timeout: (cfg.requestTimeout || 15000) * 2,
    })
    this.#axios.interceptors.request.use(async config => {
      // 官方 AccessToken 机制: Authorization: QQBot {ACCESS_TOKEN}
      config.headers.Authorization = `QQBot ${await this.getAccessToken()}`
      return config
    })
  }

  /**
   * 获取 AccessToken (缓存 + 过期前 60s 提前刷新, 供 API 与 WS Gateway 鉴权共用)
   * POST https://api.bot.qq.com/app/getAppAccessToken { appId, clientSecret } → { access_token, expires_in }
   */
  async getAccessToken (): Promise<string> {
    const now = Date.now()
    if (this.#authToken && this.#authToken.expireAt - 60_000 > now) return this.#authToken.token
    const res = await this.#authAxios.post<{ access_token?: string; expires_in?: number; message?: string }>('/app/getAppAccessToken', {
      appId: this.appId,
      clientSecret: this.clientSecret,
    })
    const data = res.data
    if (!data.access_token) throw new Error(`QQBot 获取 AccessToken 失败: ${data.message || '响应缺少 access_token'}`)
    const ttl = (Number(data.expires_in) || 7200) * 1000
    this.#authToken = { token: data.access_token, expireAt: now + ttl }
    return data.access_token
  }

  async request<T = any> (method: 'get' | 'post' | 'delete' | 'put' | 'patch', path: string, data?: any, params?: any): Promise<T> {
    let res
    if (method === 'get') {
      res = await this.#axios.get<QqBotResponse<T> | T>(path, { params })
    } else if (method === 'delete') {
      res = await this.#axios.delete<QqBotResponse<T> | T>(path, params ? { params } : undefined)
    } else if (method === 'put') {
      res = await this.#axios.put<QqBotResponse<T> | T>(path, data ?? {})
    } else if (method === 'patch') {
      res = await this.#axios.patch<QqBotResponse<T> | T>(path, data ?? {})
    } else {
      res = await this.#axios.post<QqBotResponse<T> | T>(path, data ?? {})
    }
    const body: any = res.data
    // 部分接口(如网关/文件)直接返回 data 而无包装; 失败响应统一 { code | err_code, message }
    if (body && typeof body === 'object' && ('code' in body || 'err_code' in body)) {
      const errCode = body.err_code ?? body.code
      if (errCode !== 0 && errCode !== '0') throw new Error(`QQBot API ${path} 失败: code=${errCode} ${body.message || ''}`)
      return body.data
    }
    return body as T
  }

  /* === 连接 === */
  /** 获取 Gateway WebSocket 地址 */
  getGateway = () => this.request<{ url: string; shards?: number }>('get', '/gateway')

  /* === 用户 === */
  /** 当前机器人信息 */
  me = () => this.request<QqBotUser>('get', '/users/@me')
  /** 获取用户信息(昵称/头像) */
  viewUser = (openid: string) => this.request<QqBotUser>('get', `/v2/users/${openid}`)

  /* === 频道 === */
  getGuild = (guildId: string) => this.request<QqBotGuild>('get', `/guilds/${guildId}`)
  getGuilds = () => this.request<QqBotGuild[]>('get', '/users/@me/guilds')
  /** 频道列表 */
  getGuildChannels = (guildId: string) => this.request<QqBotChannel[]>('get', `/guilds/${guildId}/channels`)
  /** 子频道详情 */
  getChannel = (channelId: string) => this.request<QqBotChannel>('get', `/channels/${channelId}`)
  /** 频道成员列表 */
  getGuildMembers = (guildId: string) => this.request<QqBotMember[]>('get', `/guilds/${guildId}/members`)
  /** 单个频道成员详情 */
  getGuildMember = (guildId: string, userId: string) => this.request<QqBotMember>('get', `/guilds/${guildId}/members/${userId}`)
  /** 踢出频道成员 (可选: add_blacklist 拉黑, delete_history_msg 退回历史消息, 仅管理员可用) */
  kickGuildMember = (guildId: string, userId: string, opts?: { addBlacklist?: boolean; deleteHistoryMsg?: boolean }) => this.request('delete', `/guilds/${guildId}/members/${userId}`, undefined, {
    ...(opts?.addBlacklist ? { add_blacklist: true } : {}),
    ...(opts?.deleteHistoryMsg ? { delete_history_msg: true } : {}),
  })
  /** 在线成员数 (音视频/交友子频道) */
  getChannelOnlineNums = (channelId: string) => this.request<{ online_nums: number }>('get', `/channels/${channelId}/online_nums`)
  /** 频道消息设置 (世界消息等) */
  getGuildMessageSetting = (guildId: string) => this.request<Record<string, any>>('get', `/guilds/${guildId}/message/setting`)

  /* === 频道身份组 === */
  getGuildRoles = (guildId: string) => this.request<{ guild_id: string; roles: QqBotRole[]; num: number }>('get', `/guilds/${guildId}/roles`)
  /** 创建身份组 (color 默认 0, hoist 是否单独展示) */
  createGuildRole = (guildId: string, body: { name: string; color?: number; hoist?: boolean }) => this.request<{ role_id: string; role: QqBotRole }>('post', `/guilds/${guildId}/roles`, body)
  /** 修改身份组 */
  updateGuildRole = (guildId: string, roleId: string, body: { name?: string; color?: number; hoist?: boolean }) => this.request<{ role_id: string; role: QqBotRole }>('patch', `/guilds/${guildId}/roles/${roleId}`, body)
  deleteGuildRole = (guildId: string, roleId: string) => this.request('delete', `/guilds/${guildId}/roles/${roleId}`)
  /** 给成员添加身份组 (channelId 限音频/交友子频道成员身份组) */
  addGuildMemberRole = (guildId: string, userId: string, roleId: string, channelId?: string) => this.request('put', `/guilds/${guildId}/members/${userId}/roles/${roleId}`, channelId ? { channel: { id: channelId } } : undefined)
  removeGuildMemberRole = (guildId: string, userId: string, roleId: string) => this.request('delete', `/guilds/${guildId}/members/${userId}/roles/${roleId}`)
  /** 身份组成员列表 (分页 next 传上一页返回值) */
  getRoleMembers = (guildId: string, roleId: string, next?: string) => this.request<{ data: QqBotMember[]; next?: string }>('get', `/guilds/${guildId}/roles/${roleId}/members`, undefined, next ? { next } : undefined)

  /* === 频道发言管理 (禁言, 仅管理员) === */
  /** 禁言成员: muteSeconds 或到点秒级时间戳 muteEndTime 二选一, 0 解除 */
  muteGuildMember = (guildId: string, userId: string, opt: { muteSeconds?: number; muteEndTime?: string }) => this.request('patch', `/guilds/${guildId}/members/${userId}/mute`, {
    ...(opt.muteEndTime ? { mute_end_timestamp: opt.muteEndTime } : {}),
    ...(opt.muteSeconds !== undefined ? { mute_seconds: String(opt.muteSeconds) } : {}),
  })
  /** 全员禁言 (同上参数; 全员禁言期间仍可单独解封某人) */
  muteGuild = (guildId: string, opt: { muteSeconds?: number; muteEndTime?: string }) => this.request('patch', `/guilds/${guildId}/mute`, {
    ...(opt.muteEndTime ? { mute_end_timestamp: opt.muteEndTime } : {}),
    ...(opt.muteSeconds !== undefined ? { mute_seconds: String(opt.muteSeconds) } : {}),
  })

  /* === 子频道管理 === */
  /** 创建子频道 (type: 0 文字 2 语音 5 直播; private_type: 0 公开 1 管理员 2 指定身份组) */
  createChannel = (guildId: string, body: { name: string; type?: number; position?: number; parentId?: string; privateType?: number; privateUserIds?: string[]; speakPermission?: number; applicationId?: string }) => this.request<QqBotChannel>('post', `/guilds/${guildId}/channels`, {
    name: body.name,
    ...(body.type !== undefined ? { type: body.type } : {}),
    ...(body.position !== undefined ? { position: body.position } : {}),
    ...(body.parentId ? { parent_id: body.parentId } : {}),
    ...(body.privateType !== undefined ? { private_type: body.privateType } : {}),
    ...(body.privateUserIds?.length ? { private_user_ids: body.privateUserIds } : {}),
    ...(body.speakPermission !== undefined ? { speak_permission: body.speakPermission } : {}),
    ...(body.applicationId ? { application_id: body.applicationId } : {}),
  })
  /** 修改子频道 (参数同创建) */
  updateChannel = (channelId: string, body: { name?: string; position?: number; parentId?: string; privateType?: number; privateUserIds?: string[]; speakPermission?: number }) => this.request<QqBotChannel>('patch', `/channels/${channelId}`, {
    ...(body.name ? { name: body.name } : {}),
    ...(body.position !== undefined ? { position: body.position } : {}),
    ...(body.parentId ? { parent_id: body.parentId } : {}),
    ...(body.privateType !== undefined ? { private_type: body.privateType } : {}),
    ...(body.privateUserIds?.length ? { private_user_ids: body.privateUserIds } : {}),
    ...(body.speakPermission !== undefined ? { speak_permission: body.speakPermission } : {}),
  })
  deleteChannel = (channelId: string) => this.request('delete', `/channels/${channelId}`)

  /* === 子频道权限 === */
  getChannelPermissions = (channelId: string, userId: string) => this.request<{ permissions: string }>('get', `/channels/${channelId}/members/${userId}/permissions`)
  getChannelRolePermissions = (channelId: string, roleId: string) => this.request<{ permissions: string }>('get', `/channels/${channelId}/roles/${roleId}/permissions`)
  /** 修改成员子频道权限 (permissions: '1' 可查看 '2' 可发言 '5' 两者, '0'/'3'/'4'/'6' 为拒绝/继承组合) */
  putChannelPermissions = (channelId: string, userId: string, permissions: string) => this.request('put', `/channels/${channelId}/members/${userId}/permissions`, { permissions })
  putChannelRolePermissions = (channelId: string, roleId: string, permissions: string) => this.request('put', `/channels/${channelId}/roles/${roleId}/permissions`, { permissions })

  /* === 频道内容 === */
  /** 创建频道公告 (channelId 可为 <sys> 全频道公告) */
  createGuildAnnounce = (guildId: string, channelId: string, messageId: string) => this.request<Record<string, any>>('post', `/guilds/${guildId}/announces`, { channel_id: channelId, message_id: messageId })
  deleteGuildAnnounce = (guildId: string, messageId: string) => this.request('delete', `/guilds/${guildId}/announces/${messageId}`)
  /** 精华消息 */
  getChannelPins = (channelId: string) => this.request<{ message_ids: string[]; message_infos: Array<{ message_id: string; content?: string; author_id?: string }> }>('get', `/channels/${channelId}/pins`)
  addChannelPin = (channelId: string, messageId: string) => this.request<{ message_ids: string[] }>('put', `/channels/${channelId}/pins/${messageId}`)
  deleteChannelPin = (channelId: string, messageId: string) => this.request('delete', `/channels/${channelId}/pins/${messageId}`)
  /** 语音子频道音频播放 (audio_control) */
  postChannelAudio = (channelId: string, body: { audioUrl?: string; text?: string; status?: number }) => this.request('post', `/channels/${channelId}/audio`, {
    ...(body.audioUrl ? { audio_url: body.audioUrl } : {}),
    ...(body.text ? { text: body.text } : {}),
    ...(body.status !== undefined ? { status: body.status } : {}),
  })
  /** 语音子频道上麦/下麦 */
  putChannelMic = (channelId: string) => this.request('put', `/channels/${channelId}/mic`)
  deleteChannelMic = (channelId: string) => this.request('delete', `/channels/${channelId}/mic`)
  /** 论坛帖子 (仅论坛子频道, 公域机器人只读) */
  getChannelThreads = (channelId: string) => this.request<{ threads: Array<Record<string, any>> }>('get', `/channels/${channelId}/threads`)
  getChannelThread = (channelId: string, threadId: string) => this.request<{ thread: Record<string, any> }>('get', `/channels/${channelId}/threads/${threadId}`)
  putChannelThread = (channelId: string, body: Record<string, any>) => this.request<{ thread_info: Record<string, any> }>('put', `/channels/${channelId}/threads`, body)
  deleteChannelThread = (channelId: string, threadId: string) => this.request('delete', `/channels/${channelId}/threads/${threadId}`)
  /** 子频道日程 (线上日历) */
  getChannelSchedules = (channelId: string, since?: string) => this.request<Array<Record<string, any>>>('get', `/channels/${channelId}/schedules`, undefined, since ? { since } : undefined)
  getChannelSchedule = (channelId: string, scheduleId: string) => this.request<Record<string, any>>('get', `/channels/${channelId}/schedules/${scheduleId}`)
  postChannelSchedule = (channelId: string, body: Record<string, any>) => this.request<Record<string, any>>('post', `/channels/${channelId}/schedules`, body)
  patchChannelSchedule = (channelId: string, scheduleId: string, body: Record<string, any>) => this.request<Record<string, any>>('patch', `/channels/${channelId}/schedules/${scheduleId}`, body)
  deleteChannelSchedule = (channelId: string, scheduleId: string) => this.request('delete', `/channels/${channelId}/schedules/${scheduleId}`)

  /* === 频道 API 权限 === */
  /** 查看 API 权限 (含 API 每日调用量) */
  getGuildApiPermission = (guildId: string) => this.request<{ apis: Array<{ path: string; method: string; auth_status: number }> }>('get', `/guilds/${guildId}/api_permission`)
  /** 申请 API 权限 (仅在机器人配置了开启权限申请时可用) */
  postGuildApiPermissionDemand = (guildId: string, path: string, method: string) => this.request('post', `/guilds/${guildId}/api_permission/demand`, { path, method })

  /* === 互动与私信会话 === */
  /** 回应按钮/菜单点击回调 (INTERACTION_CREATE 事件的 interaction_id, code 为点击按钮的 data) */
  putInteraction = (interactionId: string, code: number) => this.request('put', `/interactions/${interactionId}`, { code })
  /** 创建频道私信会话 (recipient_id 对端用户ID, source_guild_id 来源频道ID → 返回 guild_id 用于发私信) */
  createDms = (recipientId: string, sourceGuildId: string) => this.request<{ guild_id: string }>('post', '/users/@me/dms', { recipient_id: recipientId, source_guild_id: sourceGuildId })

  /* === 表情回应 (仅频道消息) === */
  addReaction = (channelId: string, messageId: string, emojiType: 1 | 2, emojiId: string) => this.request('put', `/channels/${channelId}/messages/${messageId}/reactions/${emojiType}/${emojiId}`)
  deleteReaction = (channelId: string, messageId: string, emojiType: 1 | 2, emojiId: string) => this.request('delete', `/channels/${channelId}/messages/${messageId}/reactions/${emojiType}/${emojiId}`)

  /* === 频道消息 === */
  sendChannelMessage = (channelId: string, body: Record<string, any>) => this.request<any>('post', `/channels/${channelId}/messages`, body)
  deleteChannelMessage = (channelId: string, messageId: string) => this.request('delete', `/channels/${channelId}/messages/${messageId}`)
  getChannelMessages = (channelId: string, limit?: number, before?: string) => this.request<{ messages: Array<Record<string, any>>; last: string }>('get', `/channels/${channelId}/messages`, undefined, { limit, before })
  getChannelMessage = (channelId: string, messageId: string) => this.request<Record<string, any>>('get', `/channels/${channelId}/messages/${messageId}`)
  /** 上传频道媒体素材 (file_type: 1=图片 2=视频 3=语音 4=文件) */
  postChannelFile = (channelId: string, url: string, fileType: 1 | 2 | 3 | 4 = 1, _fileData?: string, fileName?: string) => this.request<QqBotFileInfo>('post', `/channels/${channelId}/files`, { file_type: fileType, url, srv_send_msg: false, ...(fileName ? { file_name: fileName } : {}) })

  /* === 频道私信 === */
  sendDmsMessage = (guildId: string, body: Record<string, any>) => this.request<any>('post', `/dms/${guildId}/messages`, body)
  deleteDmsMessage = (guildId: string, messageId: string) => this.request('delete', `/dms/${guildId}/messages/${messageId}`)
  getDmsMessages = (guildId: string, limit?: number, before?: string) => this.request<{ messages: Array<Record<string, any>>; last: string }>('get', `/dms/${guildId}/messages`, undefined, { limit, before })
  getDmsMessage = (guildId: string, messageId: string) => this.request<Record<string, any>>('get', `/dms/${guildId}/messages/${messageId}`)
  postDmsFile = (guildId: string, url: string, fileType: 1 | 2 | 3 | 4 = 1, _fileData?: string, fileName?: string) => this.request<QqBotFileInfo>('post', `/dms/${guildId}/files`, { file_type: fileType, url, srv_send_msg: false, ...(fileName ? { file_name: fileName } : {}) })

  /* === 群聊 (api-v2) === */
  sendGroupMessage = (groupOpenid: string, body: Record<string, any>) => this.request<any>('post', `/v2/groups/${groupOpenid}/messages`, body)
  deleteGroupMessage = (groupOpenid: string, messageId: string) => this.request('delete', `/v2/groups/${groupOpenid}/messages/${messageId}`)
  getGroupMessages = (groupOpenid: string, limit?: number, before?: string) => this.request<{ messages: Array<Record<string, any>>; last: string }>('get', `/v2/groups/${groupOpenid}/messages`, undefined, { limit, before })
  /**
   * 上传群聊媒体素材 (api-v2: file_type 1=图片(png/jpg 软限20MB) 2=视频(mp4 软限30MB) 3=语音(silk) 4=文件;
   * 传 file_data(base64) 走文件流上传, 否则传公网 url 由平台下载转存; 超软限制自动降级为文件类型)
   */
  postGroupFile = (groupOpenid: string, url: string, fileType: 1 | 2 | 3 | 4 = 1, fileData?: string, fileName?: string) => this.request<QqBotFileInfo>('post', `/v2/groups/${groupOpenid}/files`, { file_type: fileType, ...(fileData ? { file_data: fileData } : { url: url || undefined }), ...(fileName ? { file_name: fileName } : {}) })

  /* === C2C 单聊 (api-v2) === */
  sendC2CMessage = (openid: string, body: Record<string, any>) => this.request<any>('post', `/v2/users/${openid}/messages`, body)
  deleteC2CMessage = (openid: string, messageId: string) => this.request('delete', `/v2/users/${openid}/messages/${messageId}`)
  getC2CMessages = (openid: string, limit?: number, before?: string) => this.request<{ messages: Array<Record<string, any>>; last: string }>('get', `/v2/users/${openid}/messages`, undefined, { limit, before })
  /** 上传单聊媒体素材 (api-v2: file_type 1=图片(png/jpg 软限20MB) 2=视频(mp4 软限30MB) 3=语音(silk) 4=文件; 传 file_data(base64) 走文件流上传, 否则传公网 url) */
  postC2CFile = (openid: string, url: string, fileType: 1 | 2 | 3 | 4 = 1, fileData?: string, fileName?: string) => this.request<QqBotFileInfo>('post', `/v2/users/${openid}/files`, { file_type: fileType, ...(fileData ? { file_data: fileData } : { url: url || undefined }), ...(fileName ? { file_name: fileName } : {}) })
}