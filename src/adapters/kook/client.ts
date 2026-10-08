import axios, { AxiosError, AxiosInstance } from 'node-karin/axios'
import { existsSync, readFileSync } from 'node:fs'
import type { BotConfig } from '../base'

/** Kook API 统一响应包装 */
type KookResponse<T = unknown> = {
  code: number
  message: string
  data: T
}

/** Kook 用户信息 */
export type KookUser = {
  id: string
  username: string
  identify_num: string
  nickname: string
  avatar: string
  online?: boolean
  bot?: boolean
  /** guild_id 参数传入时的服务器内昵称 */
  nickname_enabled?: boolean
}

/** Kook 服务器信息 */
export type KookGuild = {
  id: string
  name: string
  topic: string
  user_id: string
  icon: string
  notify_type: number
}

/** Kook 频道成员 */
export type KookChannelUser = {
  id: string
  username: string
  identify_num: string
  online: boolean
  os: string
  status: number
  avatar: string
  nickname: string
}

/**
 * Kook 官方 API 客户端。
 * base https://www.kookapp.cn/api/v3  鉴权头 `Authorization: Bot <token>`
 * 除 gateway 外均为 POST, 响应 code !== 0 时抛错。
 */
export class Client {
  #axios: AxiosInstance

  constructor (cfg: BotConfig) {
    const baseURL = 'https://www.kookapp.cn/api/v3'
    this.#axios = axios.create({
      baseURL,
      headers: { Accept: 'application/json' },
      timeout: cfg.requestTimeout || 15000,
    })
    this.#axios.interceptors.request.use(config => {
      config.headers.Authorization = `Bot ${cfg.kookToken || ''}`
      return config
    })
  }

  async request<T = any> (path: string, data?: any, method: 'get' | 'post' = 'post'): Promise<T> {
    let res
    try {
      if (method === 'get') {
        res = await this.#axios.get<KookResponse<T>>(path, { params: data })
      } else {
        res = await this.#axios.post<KookResponse<T>>(path, data ?? {})
      }
    } catch (err: any) {
      // 重组错误: 带上 HTTP 状态码与 Kook 响应体文案, 便于排查 token/参数问题
      const status = err?.response?.status
      const body = err?.response?.data
      const extra = typeof body?.message === 'string' ? ` ${body.message}${body.code != null ? ` (code=${body.code})` : ''}` : ''
      throw new Error(`Kook API ${path} 失败: HTTP ${status ?? '无响应'}${extra || ` ${err?.message || err}`}`, { cause: err })
    }
    if (res.data.code !== 0) throw new Error(`Kook API ${path} 失败: code=${res.data.code} ${res.data.message}`)
    return res.data.data
  }

  /* === 连接 === */
  /** 获取 Gateway WebSocket 地址 (compress=0 保证文本帧) */
  getGateway = () => this.request<{ url: string }>('/gateway/index', { compress: 0 }, 'get')

  /* === 用户 === */
  /** 当前机器人信息 */
  me = () => this.request<KookUser>('/user/me', undefined, 'get')
  /** 查看用户 */
  viewUser = (userId: string, guildId?: string) => this.request<KookUser>('/user/view', { user_id: userId, guild_id: guildId }, 'get')

  /* === 消息 === */
  /** 发送消息 (type=9 富文本数组 / type=10 卡片, content 为对应 JSON 字符串) */
  createMessage = (targetId: string, content: string, quote?: string, type: number = 9) => this.request<{
    msg_id: string
    msg_timestamp: number
    nonce: string
    author_id: string
    msg_seq: number
  }>('/message/create', { type, target_id: targetId, content, quote })
  /** 撤回消息 */
  deleteMessage = (msgId: string) => this.request('/message/delete', { msg_id: msgId })
  /** 查看单条消息 */
  viewMessage = (msgId: string) => this.request<Record<string, any>>('/message/view', { msg_id: msgId }, 'get')
  /** 获取频道内历史消息 (msg_id 锚点语义: flag=before 返回该消息之前的消息) */
  messageList = (targetId: string, msgId?: string, flag?: 'before' | 'around' | 'after', pageSize?: number) => this.request<{
    items: Array<Record<string, any>>
  }>('/message/list', { target_id: targetId, msg_id: msgId, flag, page_size: pageSize }, 'get')

  /* === 服务器/频道 === */
  /** 服务器成员列表 */
  guildUserList = (guildId: string, page?: number, pageSize?: number) => this.request<{
    items: Array<Record<string, any>>
    meta: { page: number; page_total: number; page_size: number; total: number }
  }>('/guild/user-list', { guild_id: guildId, page, page_size: pageSize }, 'get')
  /** 语音频道在线用户列表 */
  channelUserList = (channelId: string) => this.request<Array<Record<string, any>>>('/channel/user-list', { channel_id: channelId }, 'get')
  /** 服务器列表 */
  guildList = (page?: number, pageSize?: number) => this.request<{
    items: KookGuild[]
    meta: { page: number; page_total: number; page_size: number; total: number }
  }>('/guild/list', { page, page_size: pageSize }, 'get')
  /** 服务器详情 */
  guildView = (guildId: string) => this.request<KookGuild>('/guild/view', { guild_id: guildId }, 'get')
  /** 服务器内子频道列表 (type=1 文字频道) */
  channelList = (guildId: string) => this.request<Array<Record<string, any>>>('/channel/list', { guild_id: guildId, type: 1 }, 'get')
  /** 子频道详情 */
  channelView = (channelId: string) => this.request<Record<string, any>>('/channel/view', { channel_id: channelId }, 'get')

  /* === 消息编辑/互动 === */
  /** 编辑消息(仅频道内自己发送的消息; type=9 文本/card 数组, type=10 卡片 JSON) */
  updateMessage = (msgId: string, content: string, quote?: string, type: number = 9) => this.request<{
    msg_id: string
    msg_timestamp: number
  }>('/message/update', { msg_id: msgId, content, quote, type })
  /** 添加消息表情回应 (emoji 为 KMarkdown 表情写法或对应 ID) */
  addReaction = (msgId: string, emoji: string) => this.request('/message/add-reaction', { msg_id: msgId, emoji })
  /** 删除消息表情回应 */
  deleteReaction = (msgId: string, emoji: string) => this.request('/message/delete-reaction', { msg_id: msgId, emoji })
  /** 消息点赞 */
  upvote = (msgId: string) => this.request('/message/upvote', { msg_id: msgId })

  /* === 服务器角色 === */
  /** 服务器角色列表 (可用于填充管理员/角色信息) */
  guildRoleList = (guildId: string) => this.request<Array<Record<string, any>>>('/guild/role-list', { guild_id: guildId }, 'get')

  /* === 服务器管理 === */
  /** 踢出服务器成员 */
  guildKickout = (guildId: string, targetId: string) => this.request('/guild/kickout', { guild_id: guildId, target_id: targetId })
  /** 修改成员服务器内昵称 (nickname 不传或空串则清空昵称; user_id 不传则修改机器人自己) */
  guildNickname = (guildId: string, nickname?: string, userId?: string) => this.request('/guild/nickname', { guild_id: guildId, nickname, user_id: userId })
  /** 离开服务器 */
  guildLeave = (guildId: string) => this.request('/guild/leave', { guild_id: guildId })
  /**
   * 语音闭麦/解除 (Kook 无文字禁言, 此接口作用于语音: type=1 麦克风闭麦, type=2 耳机静音)
   * isMute=true 生效 / false 解除。
   */
  guildMute = (guildId: string, userId: string, type: 1 | 2, isMute: boolean) =>
    isMute
      ? this.request('/guild-mute/create', { guild_id: guildId, user_id: userId, type })
      : this.request('/guild-mute/delete', { guild_id: guildId, user_id: userId, type })

  /* === 频道管理 === */
  /** 创建频道 (type: 1 文字 2 语音; speak_permission: 0 所有成员 1 仅管理员) */
  channelCreate = (guildId: string, name: string, type: 1 | 2 = 1, opts: { parentId?: string; limit?: number; isPrivate?: boolean; privateKey?: string; speakPermission?: number } = {}) =>
    this.request<Record<string, any>>('/channel/create', {
      guild_id: guildId,
      name,
      type,
      ...(opts.parentId ? { parent_id: opts.parentId } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
      ...(opts.isPrivate !== undefined ? { is_private: opts.isPrivate } : {}),
      ...(opts.privateKey ? { private_key: opts.privateKey } : {}),
      ...(opts.speakPermission !== undefined ? { speak_permission: opts.speakPermission } : {}),
    })
  /** 修改频道 */
  channelUpdate = (channelId: string, opts: { name?: string; topic?: string; limit?: number; password?: string; isPrivate?: boolean; speakPermission?: number } = {}) =>
    this.request('/channel/update', {
      channel_id: channelId,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.topic ? { topic: opts.topic } : {}),
      ...(opts.limit ? { limit: opts.limit } : {}),
      ...(opts.password ? { password: opts.password } : {}),
      ...(opts.isPrivate !== undefined ? { is_private: opts.isPrivate } : {}),
      ...(opts.speakPermission !== undefined ? { speak_permission: opts.speakPermission } : {}),
    })
  channelDelete = (channelId: string) => this.request('/channel/delete', { channel_id: channelId })
  /** 机器人加入语音频道 (启用语音服务) */
  channelJoin = (channelId: string) => this.request<{ audio_ssrc: string; audio_url: string }>('/channel/join', { channel_id: channelId })
  channelLeave = (channelId: string) => this.request('/channel/leave', { channel_id: channelId })
  /** 将用户移动到其他语音频道 (需管理员) */
  channelMoveUser = (targetId: string, channelId: string) => this.request('/channel/move-user', { target_id: targetId, channel_id: channelId })

  /* === 身份组管理 === */
  guildRoleCreate = (guildId: string, opts: { name?: string; color?: number; hoist?: boolean; mentionable?: boolean; permissions?: number } = {}) =>
    this.request<{ role: Record<string, any>; role_id: string }>('/guild-role/create', {
      guild_id: guildId,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.color !== undefined ? { color: opts.color } : {}),
      ...(opts.hoist !== undefined ? { hoist: opts.hoist } : {}),
      ...(opts.mentionable !== undefined ? { mentionable: opts.mentionable } : {}),
      ...(opts.permissions !== undefined ? { permissions: opts.permissions } : {}),
    })
  guildRoleUpdate = (guildId: string, roleId: string, opts: { name?: string; color?: number; position?: number; hoist?: boolean; mentionable?: boolean; permissions?: number } = {}) =>
    this.request<{ role: Record<string, any>; role_id: string }>('/guild-role/update', {
      guild_id: guildId,
      role_id: roleId,
      ...(opts.name ? { name: opts.name } : {}),
      ...(opts.color !== undefined ? { color: opts.color } : {}),
      ...(opts.position !== undefined ? { position: opts.position } : {}),
      ...(opts.hoist !== undefined ? { hoist: opts.hoist } : {}),
      ...(opts.mentionable !== undefined ? { mentionable: opts.mentionable } : {}),
      ...(opts.permissions !== undefined ? { permissions: opts.permissions } : {}),
    })
  guildRoleDelete = (guildId: string, roleId: string) => this.request<{ role_id: string }>('/guild-role/delete', { guild_id: guildId, role_id: roleId })
  /** 给成员附加身份组 (roleIds 可传多个) */
  guildRoleGrant = (guildId: string, userId: string, roleIds: string[]) => this.request<{ user_id: string; guild_id: string; roles: string[] }>('/guild-role/grant', { guild_id: guildId, user_id: userId, role_ids: roleIds })
  guildRoleRevoke = (guildId: string, userId: string, roleIds: string[]) => this.request<{ user_id: string; guild_id: string; roles: string[] }>('/guild-role/revoke', { guild_id: guildId, user_id: userId, role_ids: roleIds })

  /* === 服务器表情 === */
  guildEmojiList = (guildId: string) => this.request<{ items: Array<Record<string, any>> }>('/guild-emoji/list', { guild_id: guildId }, 'get')
  guildEmojiDelete = (emojiId: string) => this.request('/guild-emoji/delete', { id: emojiId })

  /* === 黑名单 === */
  blacklistList = (guildId: string, page?: number, pageSize?: number) => this.request<{ items: Array<Record<string, any>>; meta: Record<string, any> }>('/blacklist/list', { guild_id: guildId, page, page_size: pageSize }, 'get')
  /** 拉黑成员 (remark 备注, delMsgDays 删除其最近 n 天消息) */
  blacklistCreate = (guildId: string, targetId: string, opts: { remark?: string; delMsgDays?: number } = {}) => this.request<{ user_id: string }>('/blacklist/create', { guild_id: guildId, target_id: targetId, ...(opts.remark ? { remark: opts.remark } : {}), ...(opts.delMsgDays ? { del_msg_days: opts.delMsgDays } : {}) })
  blacklistDelete = (guildId: string, targetId: string) => this.request<{ user_id: string }>('/blacklist/delete', { guild_id: guildId, target_id: targetId })

  /* === 邀请链接 === */
  inviteList = (opts: { guildId?: string; channelId?: string; page?: number; pageSize?: number } = {}) => this.request<{ items: Array<Record<string, any>>; meta: Record<string, any> }>('/invite/list', { guild_id: opts.guildId, channel_id: opts.channelId, page: opts.page, page_size: opts.pageSize }, 'get')
  /** 创建邀请 (duration 有效秒数 0永久; settingTimes 可用次数 0不限; settingStartTime 生效时间戳) */
  inviteCreate = (guildId: string, opts: { channelId?: string; duration?: number; settingTimes?: number; settingStartTime?: string } = {}) => this.request<{ url: string; url_code: string }>('/invite/create', {
    guild_id: guildId,
    ...(opts.channelId ? { channel_id: opts.channelId } : {}),
    ...(opts.duration !== undefined ? { duration: opts.duration } : {}),
    ...(opts.settingTimes !== undefined ? { setting_times: opts.settingTimes } : {}),
    ...(opts.settingStartTime ? { setting_start_time: opts.settingStartTime } : {}),
  })
  inviteDelete = (urlCode: string) => this.request<{ url: string; guild_id: string }>('/invite/delete', { url_code: urlCode })

  /* === 亲密度 (机器人与用户的个人资料页互动信息) === */
  intimacyIndex = (userId?: string) => this.request<Record<string, any>>('/intimacy/index', { user_id: userId }, 'get')
  intimacyUpdate = (userId: string, opts: { score?: number; socialInfo?: string; imgId?: string } = {}) => this.request('/intimacy/update', { user_id: userId, ...(opts.score !== undefined ? { score: opts.score } : {}), ...(opts.socialInfo ? { social_info: opts.socialInfo } : {}), ...(opts.imgId ? { img_id: opts.imgId } : {}) })

  /* === 游戏 (机器人在线状态展示) === */
  gameList = () => this.request<{ items: Array<Record<string, any>> }>('/game/list', undefined, 'get')
  gameCreate = (name: string, icon?: string) => this.request<{ id: string; game: Record<string, any> }>('/game/create', { name, ...(icon ? { icon } : {}) })
  gameUpdate = (id: string, opts: { name?: string; icon?: string } = {}) => this.request<{ id: string; game: Record<string, any> }>('/game/update', { id, ...(opts.name ? { name: opts.name } : {}), ...(opts.icon ? { icon: opts.icon } : {}) })
  gameDelete = (id: string) => this.request('/game/delete', { id })
  /** 更新机器人在线状态: type=1 玩游戏显示 dataName(已建游戏传 dataId), type=0 恢复默认状态 */
  gameActivity = (opts: { type: 0 | 1; dataId?: string; dataName?: string }) => this.request('/game/activity', { type: opts.type, ...(opts.dataId ? { data_id: opts.dataId } : {}), ...(opts.dataName ? { data_name: opts.dataName } : {}) })

  /* === 消息回应详情 === */
  /** 查看 emoji 回应的成员列表 (emoji 传如 `:[name]:[id]:` 形式) */
  reactionList = (msgId: string, emoji: string, userId?: string, pageSize?: number) => this.request<{ items: Array<{ user: KookUser; msg_id: string; reaction_type: number; emoji: Record<string, any> }>; meta: Record<string, any> }>('/message/reaction-list', { msg_id: msgId, emoji, ...(userId ? { user_id: userId } : {}), page_size: pageSize }, 'get')

  /* === 私聊会话 === */
  /** 机器人与用户的私聊会话列表 */
  userChatList = (page?: number, pageSize?: number) => this.request<{ items: Array<Record<string, any>>; meta: Record<string, any> }>('/user-chat/list', { page, page_size: pageSize }, 'get')

  /* === 私信 (直发用户, 无需先有私信会话) === */
  /** 创建并发送私信消息 targetId=目标用户ID 成功返回私信频道ID */
  directCreate = (targetId: string, content: string, quote?: string, tempTargetId?: string, type: number = 9) => this.request<{
    code: number
    msg_id: string
    msg_timestamp: number
    channel_id?: string
  }>('/direct-message/create', { type, target_id: targetId, content, quote, temp_target_id: tempTargetId })
  /** 私信频道列表 (chat_code 与 target_id 至少传一个; 历史消息用 msg_id+flag 锚点分页) */
  directMessageList = (params: {
    chatCode?: string
    targetId?: string
    msgId?: string
    flag?: 'before' | 'around' | 'after'
    pageSize?: number
    page?: number
  } = {}) => this.request<{
    items: Array<Record<string, any>>
    meta: { page: number; page_total: number; page_size: number; total: number }
  }>('/direct-message/list', {
    chat_code: params.chatCode,
    target_id: params.targetId,
    msg_id: params.msgId,
    flag: params.flag,
    page_size: params.pageSize,
    page: params.page,
  }, 'get')

  /* === 资源上传 === */
  /**
   * 上传资源到 Kook, 返回可直接用于消息 content 的 http(s) URL。
   * file 支持: base64://、data: URL、http(s) URL、本地文件路径、Buffer。
   */
  uploadAsset = async (file: string | Buffer, type: 'file' | 'image' | 'audio' = 'file'): Promise<string> => {
    const { buffer, filename } = await this.#resolveFile(file)
    // Kook 依文件名/二进制识别媒体类型, 无扩展名可能不被接收, 按类型兜底扩展名
    const ext = type === 'image' ? 'png' : type === 'audio' ? 'mp3' : 'bin'
    const name = /\.\w+$/.test(filename) ? filename : `${filename}.${ext}`
    const form = new FormData()
    form.append('file', new Blob([new Uint8Array(buffer)]), name)
    // 官方要求 Content-Type 为 multipart/form-data, 必须携带 boundary。
    // 由 FormData.getHeaders() 生成完整头 (axios 检测到 FormData 也会自动生成),
    // 不能硬编码无 boundary 的 'multipart/form-data', 否则 Kook 解析 multipart 失败, 静默返回占位 URL 404.raw。
    const headers: Record<string, string> = {}
    if (typeof (form as any).getHeaders === 'function') {
      const hs = (form as any).getHeaders() as Record<string, string>
      for (const [k, v] of Object.entries(hs)) headers[k.toLowerCase()] = String(v)
    }
    let res
    try {
      res = await this.#axios.post<KookResponse<{ url: string }>>('/asset/create', form, { headers })
    } catch (err: any) {
      const extra = err?.response?.data?.message ? ` ${err.response.data.message}` : ''
      throw new Error(`Kook API /asset/create 失败: HTTP ${err?.response?.status ?? '无响应'}${extra || ` ${err?.message || err}`}`, { cause: err })
    }
    if (res.data.code !== 0) throw new Error(`Kook API /asset/create 失败: code=${res.data.code} ${res.data.message}`)
    // Kook 对未正确接收的资源返回占位地址, 视为上传失败
    if (/\/404\.raw$/.test(res.data.data.url)) {
      throw new Error(`Kook API /asset/create 失败: 返回占位地址 ${res.data.data.url}, 上传未生效 (检查 multipart boundary 与文件名扩展名)`)
    }
    return res.data.data.url
  }

  /** 将各种来源的媒体资源解析为 { buffer, filename } */
  async #resolveFile (file: string | Buffer): Promise<{ buffer: Buffer; filename: string }> {
    if (Buffer.isBuffer(file)) return { buffer: file, filename: `file_${Date.now()}` }
    // base64://
    if (file.startsWith('base64://')) {
      return { buffer: Buffer.from(file.slice('base64://'.length), 'base64'), filename: `file_${Date.now()}` }
    }
    // data: URL (支持 base64 与百分号编码两种载荷)
    const dataMatch = /^data:([^;,]+)?(;base64)?,(.+)$/s.exec(file)
    if (dataMatch) {
      const isBase64 = !!dataMatch[2]
      const payload = dataMatch[3]
      const ext = (dataMatch[1] || '').split('/')[1]?.split(';')[0] || ''
      return {
        buffer: isBase64 ? Buffer.from(payload, 'base64') : Buffer.from(decodeURIComponent(payload)),
        filename: `file_${Date.now()}${ext ? `.${ext}` : ''}`,
      }
    }
    // http(s) URL: 下载后上传, 文件名取路径尾段
    if (/^https?:\/\//i.test(file)) {
      const res = await this.#axios.get<ArrayBuffer>(file, { responseType: 'arraybuffer' })
      const filename = file.split('/').pop()?.split('?')[0] || `file_${Date.now()}`
      return { buffer: Buffer.from(res.data), filename }
    }
    // 本地文件路径
    if (existsSync(file)) {
      return { buffer: readFileSync(file), filename: file.split(/[\\/]/).pop() || `file_${Date.now()}` }
    }
    throw new Error(`无法识别的媒体源: ${file.slice(0, 60)}...`)
  }
}