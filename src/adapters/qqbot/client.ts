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
    const baseURL = (cfg.qqbotApi || 'https://api.bot.qq.com').replace(/\/+$/, '')
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

  async request<T = any> (method: 'get' | 'post' | 'delete' | 'put', path: string, data?: any, params?: any): Promise<T> {
    let res
    if (method === 'get') {
      res = await this.#axios.get<QqBotResponse<T> | T>(path, { params })
    } else if (method === 'delete') {
      res = await this.#axios.delete<QqBotResponse<T> | T>(path)
    } else if (method === 'put') {
      res = await this.#axios.put<QqBotResponse<T> | T>(path, data ?? {})
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
  /** 频道成员列表 */
  getGuildMembers = (guildId: string) => this.request<QqBotMember[]>('get', `/guilds/${guildId}/members`)

  /* === 表情回应 (仅频道消息) === */
  addReaction = (channelId: string, messageId: string, emojiType: 1 | 2, emojiId: string) => this.request('put', `/channels/${channelId}/messages/${messageId}/reactions/${emojiType}/${emojiId}`)
  deleteReaction = (channelId: string, messageId: string, emojiType: 1 | 2, emojiId: string) => this.request('delete', `/channels/${channelId}/messages/${messageId}/reactions/${emojiType}/${emojiId}`)

  /* === 频道消息 === */
  sendChannelMessage = (channelId: string, body: Record<string, any>) => this.request<any>('post', `/channels/${channelId}/messages`, body)
  deleteChannelMessage = (channelId: string, messageId: string) => this.request('delete', `/channels/${channelId}/messages/${messageId}`)
  getChannelMessages = (channelId: string, limit?: number, before?: string) => this.request<{ messages: Array<Record<string, any>>; last: string }>('get', `/channels/${channelId}/messages`, undefined, { limit, before })
  getChannelMessage = (channelId: string, messageId: string) => this.request<Record<string, any>>('get', `/channels/${channelId}/messages/${messageId}`)
  /** 上传频道媒体素材 (file_type: 1=图片 2=视频 3=语音 4=文件) */
  postChannelFile = (channelId: string, url: string, fileType: 1 | 2 | 3 | 4 = 1, _fileData?: string) => this.request<QqBotFileInfo>('post', `/channels/${channelId}/files`, { file_type: fileType, url, srv_send_msg: false })

  /* === 频道私信 === */
  sendDmsMessage = (guildId: string, body: Record<string, any>) => this.request<any>('post', `/dms/${guildId}/messages`, body)
  deleteDmsMessage = (guildId: string, messageId: string) => this.request('delete', `/dms/${guildId}/messages/${messageId}`)
  getDmsMessages = (guildId: string, limit?: number, before?: string) => this.request<{ messages: Array<Record<string, any>>; last: string }>('get', `/dms/${guildId}/messages`, undefined, { limit, before })
  getDmsMessage = (guildId: string, messageId: string) => this.request<Record<string, any>>('get', `/dms/${guildId}/messages/${messageId}`)
  postDmsFile = (guildId: string, url: string, fileType: 1 | 2 | 3 | 4 = 1, _fileData?: string) => this.request<QqBotFileInfo>('post', `/dms/${guildId}/files`, { file_type: fileType, url, srv_send_msg: false })

  /* === 群聊 (api-v2) === */
  sendGroupMessage = (groupOpenid: string, body: Record<string, any>) => this.request<any>('post', `/v2/groups/${groupOpenid}/messages`, body)
  deleteGroupMessage = (groupOpenid: string, messageId: string) => this.request('delete', `/v2/groups/${groupOpenid}/messages/${messageId}`)
  getGroupMessages = (groupOpenid: string, limit?: number, before?: string) => this.request<{ messages: Array<Record<string, any>>; last: string }>('get', `/v2/groups/${groupOpenid}/messages`, undefined, { limit, before })
  /** 上传群聊媒体素材 (api-v2: file_type 1=图片 2=视频 3=语音 4=文件; 传 file_data(base64) 走文件流上传, 否则传公网 url) */
  postGroupFile = (groupOpenid: string, url: string, fileType: 1 | 2 | 3 | 4 = 1, fileData?: string) => this.request<QqBotFileInfo>('post', `/v2/groups/${groupOpenid}/files`, fileData ? { file_type: fileType, file_data: fileData } : { file_type: fileType, url })

  /* === C2C 单聊 (api-v2) === */
  sendC2CMessage = (openid: string, body: Record<string, any>) => this.request<any>('post', `/v2/users/${openid}/messages`, body)
  deleteC2CMessage = (openid: string, messageId: string) => this.request('delete', `/v2/users/${openid}/messages/${messageId}`)
  getC2CMessages = (openid: string, limit?: number, before?: string) => this.request<{ messages: Array<Record<string, any>>; last: string }>('get', `/v2/users/${openid}/messages`, undefined, { limit, before })
  /** 上传单聊媒体素材 (api-v2: file_type 1=图片 2=视频 3=语音 4=文件; 传 file_data(base64) 走文件流上传, 否则传公网 url) */
  postC2CFile = (openid: string, url: string, fileType: 1 | 2 | 3 | 4 = 1, fileData?: string) => this.request<QqBotFileInfo>('post', `/v2/users/${openid}/files`, fileData ? { file_type: fileType, file_data: fileData } : { file_type: fileType, url })
}