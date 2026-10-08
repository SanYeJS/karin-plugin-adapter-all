import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import {
  contactFriend,
  createFriendMessage,
  logger,
  senderFriend,
} from 'node-karin'
import type {
  Contact,
  DownloadFileOptions,
  DownloadFileResponse,
  Elements,
  GroupInfo,
  GroupMemberInfo,
  GroupSender,
  MessageResponse,
  NodeElement,
  SendElement,
  SendMsgResults,
  UserInfo,
} from 'node-karin'
import { BaseBot } from '../base'
import type { BotConfig } from '../base'
import { applyMsgReplace } from '../../utils/msgReplace'
import { dir } from '../../dir'
import { isTokenInvalid, WechatClient } from './client'
import { nodeElements, parseItems, toBatches } from './convert'
import { history } from './history'
import { state } from './state'
import { msgId, sleep, uuid } from './common'
import { http } from './http'
import { DEFAULT_BASE_URL, LONG_POLL_TIMEOUT, TYPING_KEEPALIVE, TYPING_TICKET_TTL, TYPING_TTL } from './types'
import type { IlinkMessage, SendMessageResponse, TypingState } from './types'

/** 微信 Claw (ilink 协议) 适配器: 纯 HTTP 长轮询 */
export class WxocBot extends BaseBot {
  /** ilink 协议客户端 */
  super: WechatClient
  /** 是否已主动停止(停止后不再轮询) */
  #stopped = false
  /** 消息去重缓存 */
  #seen = new Map<string, number>()
  /** 消息缓存 供 getMsg / 引用还原使用 */
  #cache = new Map<string, MessageResponse>()
  /** 正在输入状态 */
  #typing = new Map<string, TypingState>()

  constructor (cfg: BotConfig) {
    super(cfg)
    this.super = new WechatClient({ token: cfg.wxocToken, baseUrl: cfg.wxocBaseUrl })

    this.adapter.name = 'WeixinClaw'
    this.adapter.version = dir.version
    this.adapter.platform = 'wechat'
    this.adapter.standard = 'other'
    this.adapter.protocol = 'wxoc'
    this.adapter.communication = 'other'
    this.adapter.address = cfg.wxocBaseUrl || DEFAULT_BASE_URL

    this.account.selfId = cfg.wxocAccountId || ''
    this.account.uin = cfg.wxocAccountId || ''
    this.account.uid = cfg.wxocUserId || cfg.wxocAccountId || ''
    this.account.name = cfg.wxocNickname || cfg.wxocAccountId || ''
  }

  /** 打印当前 Bot 专属日志 */
  logger (level: 'info' | 'error' | 'trace' | 'debug' | 'mark' | 'warn' | 'fatal', ...args: any[]) {
    logger.bot(level, this.account.selfId, ...args)
  }

  /** 启动: 校验凭证 + 注册 + 启动长轮询 */
  async start (): Promise<void> {
    if (this.#stopped) this.#stopped = false
    // 轻量请求校验凭证可用性 (上线通知)
    try {
      await this.super.notify(true)
    } catch (error) {
      if (isTokenInvalid(error)) throw new Error(`登录凭证已失效 请重新扫码登录: ${(error as Error).message}`)
      // 非凭证错误不阻塞启动 轮询中会重试
      this.logger('warn', `上线通知失败: ${(error as Error).message}`)
    }

    this.register()
    // 长轮询循环后台运行
    this.#poll().catch(() => { })
  }

  /** 停止轮询并注销 */
  async stop (): Promise<void> {
    this.#stopped = true
    this.unregister()
    // 通知服务端下线 尽力而为
    await this.super.notify(false).catch(() => { })
  }

  /** 消息轮询 */
  async #poll (): Promise<void> {
    let errors = 0
    /** 下轮长轮询超时 优先使用服务端建议值 */
    let pollTimeout = LONG_POLL_TIMEOUT

    while (!this.#stopped) {
      try {
        const syncBuf = await state.getSyncBuf(this.account.selfId)
        const result = await this.super.getUpdates(syncBuf, pollTimeout)
        pollTimeout = result.longpolling_timeout_ms || LONG_POLL_TIMEOUT
        if (errors >= 3) this.logger('info', `网络恢复 (共重试${errors}次)`)
        errors = 0

        /** 全部处理成功后才推进游标 避免处理失败丢消息 */
        for (const msg of result.msgs || []) {
          if (this.#stopped) return
          await this.#onMessage(msg)
        }
        if (!this.#stopped && result.get_updates_buf) {
          await state.setSyncBuf(this.account.selfId, result.get_updates_buf)
        }
      } catch (error) {
        if (this.#stopped) return

        const message = (error as Error).message || ''
        if (isTokenInvalid(error)) {
          this.unregister()
          this.logger('error', `登录凭证已失效 请重新扫码登录: ${message}`)
          return
        }
        if (/timeout/i.test(message) || (error as Error).name === 'AbortError') continue

        errors++
        const ms = Math.min(errors * 5000, 300000)
        /** 前3次逐条报 之后每10次汇总一条 避免刷屏 */
        if (errors <= 3 || errors % 10 === 0) {
          this.logger('warn', `轮询断开 (第${errors}次重连 休眠${ms / 1000}s): ${message}`)
        }
        await sleep(ms)
      }
    }
  }

  /** 处理收到的消息 */
  async #onMessage (msg: IlinkMessage): Promise<void> {
    const userId = msg.from_user_id
    if (!userId) return

    const messageId = msg.message_id || msg.msg_id || msgId()
    const dedupKey = `${this.account.selfId}:${messageId}:${msg.client_id || ''}`
    if (this.#seen.has(dedupKey)) return

    if (msg.context_token) await state.setContext(this.account.selfId, userId, msg.context_token)
    /** 记录联系人昵称 供好友列表使用 */
    if (msg.from_user_name) await state.setContact(this.account.selfId, userId, msg.from_user_name)

    /** 引用还原 仅携带 svr_id 时从本地缓存取 */
    const { elements } = await parseItems(
      this.super,
      msg.item_list,
      (id: string) => this.#cache.get(id)?.elements || []
    )
    if (!elements.length) return

    /** 入站文本段应用消息正则替换 (如 /命令 → #命令) */
    const replaced = applyMsgReplace(elements, this.cfg.msgReplace, this.cfg.msgReplaceEnable)

    const nickname = msg.from_user_name || this.account.name
    const contact = contactFriend(userId, nickname)
    const raw: MessageResponse = {
      time: Date.now(),
      messageId,
      messageSeq: Number(messageId) || 0,
      contact,
      sender: senderFriend(userId, nickname) as unknown as GroupSender,
      elements: replaced,
    }

    this.#cacheMessage(raw)
    createFriendMessage({
      bot: this,
      time: raw.time,
      contact,
      sender: senderFriend(userId, nickname),
      rawEvent: raw,
      messageId,
      messageSeq: raw.messageSeq,
      eventId: messageId,
      elements: replaced,
      srcReply: elements => this.sendMsg(contact, elements),
    })

    this.#seen.set(dedupKey, Date.now())
    while (this.#seen.size > 500) {
      this.#seen.delete(this.#seen.keys().next().value as string)
    }
  }

  /** 缓存消息 内存快路径 + 持久化 供 getMsg / 引用消息 / 历史消息获取 */
  #cacheMessage (raw: MessageResponse): void {
    this.#cache.set(raw.messageId, raw)
    setTimeout(() => this.#cache.delete(raw.messageId), 10 * 60 * 1000)
    while (this.#cache.size > 100) {
      const first = this.#cache.keys().next().value as string
      this.#cache.delete(first)
    }
    history.save(this.account.selfId, raw).catch(error => {
      this.logger('warn', `保存历史消息失败: ${(error as Error).message}`)
    })
  }

  /** 发送消息 */
  async sendMsg (contact: Contact, elements: Array<SendElement>, retryCount = 0): Promise<SendMsgResults> {
    if (contact.scene !== 'friend') throw new Error('微信Claw仅支持好友私聊')

    const peerId = contact.peer
    const contextToken = await state.getContext(this.account.selfId, peerId)
    if (!contextToken) {
      throw new Error('缺少上下文 contextToken 无法发送消息 请先让对方给你发一条消息')
    }

    const { batches, nodes } = await toBatches(this.super, peerId, elements)
    if (!batches.length && !nodes.length) throw new Error('消息为空或不支持的消息类型')

    this.stopTyping(peerId).catch(() => { })

    try {
      const results: SendMessageResponse[] = []
      for (const batch of batches) {
        results.push(await this.super.sendMessage(peerId, batch, contextToken))
      }
      for (const node of nodes) {
        await this.sendForwardMsg(contact, [node])
      }

      const messageId = String(results[0]?.msg?.message_id || results[0]?.message_id || uuid().slice(0, 20))

      /** 发送的消息也存入历史 */
      this.#cacheMessage({
        time: Date.now(),
        messageId,
        messageSeq: Number(messageId) || 0,
        contact,
        sender: senderFriend(this.account.selfId, this.account.name) as unknown as GroupSender,
        elements: elements as Elements[],
      })

      return { messageId, time: Date.now(), rawData: results, message_id: messageId, messageTime: Date.now() }
    } catch (error) {
      if (retryCount > 0) return this.sendMsg(contact, elements, retryCount - 1)

      const message = (error as Error).message || ''
      if (message.includes('ret=-2')) {
        await state.clearContext(this.account.selfId, peerId)
        throw new Error('上下文 contextToken 已过期 请先让对方给你发一条消息')
      }
      throw error
    }
  }

  /** 发送合并转发消息 降级为逐条发送 */
  async sendForwardMsg (contact: Contact, elements: Array<NodeElement>): Promise<{ messageId: string; forwardId: string }> {
    const parts: Elements[] = []
    for (const node of elements) parts.push(...nodeElements(node))

    let messageId = ''
    for (const part of parts) {
      const result = await this.sendMsg(contact, [part])
      messageId = result.messageId
    }
    if (!messageId) throw new Error('合并转发消息为空')

    /** 缓存合成消息 供 getForwardMsg / sendLongMsg 使用 */
    this.#cache.set(messageId, {
      time: Date.now(),
      messageId,
      messageSeq: Number(messageId) || 0,
      contact,
      sender: senderFriend(this.account.selfId, this.account.name) as unknown as GroupSender,
      elements: parts,
    })
    return { messageId, forwardId: messageId }
  }

  /** 获取合并转发消息 仅支持本账号发送过的 */
  async getForwardMsg (resId: string): Promise<Array<MessageResponse>> {
    const raw = this.#cache.get(resId)
    return raw ? [raw] : []
  }

  /** 发送长消息 基于已发送的转发内容重发 */
  async sendLongMsg (contact: Contact, resId: string): Promise<SendMsgResults> {
    const [raw] = await this.getForwardMsg(resId)
    if (!raw) throw new Error('长消息内容不存在或已过期')
    return this.sendMsg(contact, raw.elements as Array<SendElement>)
  }

  /** 构造资源ID 协议不支持仅上传 降级为实际发送合并转发 */
  async createResId (contact: Contact, elements: Array<NodeElement>): Promise<string> {
    const { forwardId } = await this.sendForwardMsg(contact, elements)
    return forwardId
  }

  /** 上传文件 降级为直接发送文件消息 */
  async uploadFile (contact: Contact, file: string, name: string): Promise<void> {
    const element: SendElement = { type: 'file', file: `file://${file}`, name }
    await this.sendMsg(contact, [element])
  }

  /** 下载文件到插件数据目录 支持 url 和 base64 */
  async downloadFile (options?: DownloadFileOptions): Promise<DownloadFileResponse> {
    const root = path.join(dir.karinPath, 'data', 'downloads')
    await mkdir(root, { recursive: true })

    if (options && 'base64' in options && options.base64) {
      const fileName = options.fileName || createHash('md5').update(options.base64).digest('hex')
      const filePath = path.join(root, fileName)
      await writeFile(filePath, Buffer.from(options.base64, 'base64'))
      return { filePath }
    }

    if (!options?.url) throw new Error('downloadFile 需要 url 或 base64')

    const response = await http({
      url: options.url,
      method: 'get',
      responseType: 'arraybuffer',
    }, '下载文件失败')

    const buffer = Buffer.from(response.data as ArrayBuffer)

    const ext = path.extname(new URL(options.url).pathname) || '.bin'
    const fileName = options.fileName || `${createHash('md5').update(buffer).digest('hex')}${ext}`
    const filePath = path.join(root, fileName)
    await writeFile(filePath, buffer)
    return { filePath }
  }

  /** 微信Claw不支持撤回消息 */
  async recallMsg (): Promise<void> {
    throw new Error('微信Claw协议不支持撤回消息')
  }

  /** 获取消息 提供 messageId 时查缓存和历史文件 未提供时返回该会话最新一条 */
  async getMsg (contact: Contact | string, messageId?: string): Promise<MessageResponse> {
    const id = typeof contact === 'string' ? contact : messageId || ''
    if (id) {
      return this.#cache.get(id) || (await history.get(this.account.selfId, id)) as MessageResponse
    }

    if (typeof contact === 'string') throw new Error('获取消息需要提供消息ID')
    const [raw] = await history.list(this.account.selfId, contact.peer, '', 1)
    if (!raw) throw new Error('未找到历史消息')
    return raw
  }

  /** 获取历史消息 从本地历史读取 startMsgId 为空取最新 count 条 */
  async getHistoryMsg (contact: Contact, startMsgId: string | number, count: number = 1): Promise<Array<MessageResponse>> {
    return history.list(this.account.selfId, contact.peer, startMsgId ? String(startMsgId) : '', Math.max(1, count || 1))
  }

  /** 获取陌生人信息 */
  async getStrangerInfo (targetId: string): Promise<UserInfo> {
    const contact = await state.getContact(this.account.selfId, targetId)
    return { userId: targetId, uid: targetId, nick: contact?.name || '' }
  }

  /** ilink API 不提供头像查询接口 返回空字符串 */
  async getAvatarUrl (_userId: string, _size?: 0 | 40 | 100 | 140): Promise<string> {
    return ''
  }

  /** 微信Claw不支持群聊 */
  async getGroupAvatarUrl (_groupId: string, _size?: 0 | 40 | 100 | 140, _history?: number): Promise<string> {
    throw new Error('微信Claw不支持群聊')
  }

  /** 获取好友列表 基于已收发消息的联系人缓存 */
  async getFriendList (): Promise<Array<UserInfo>> {
    const contacts = await state.getContacts(this.account.selfId)
    return contacts.map(contact => ({ userId: contact.userId, uid: contact.userId, nick: contact.name }))
  }

  /** 微信Claw不支持群聊 返回空列表 */
  async getGroupList (): Promise<Array<GroupInfo>> {
    return []
  }

  /** 微信Claw不支持群聊 */
  async getGroupInfo (_groupId: string): Promise<GroupInfo> {
    throw new Error('微信Claw不支持群聊')
  }

  /** 微信Claw不支持群聊 返回空列表 */
  async getGroupMemberList (_groupId: string): Promise<Array<GroupMemberInfo>> {
    return []
  }

  /** 微信Claw不支持群聊 */
  async getGroupMemberInfo (_groupId: string, targetId: string): Promise<GroupMemberInfo> {
    throw new Error(`微信Claw不支持群聊 (${targetId})`)
  }

  /** 发送"正在输入"状态 返回ownerId 供 stopTyping 使用 */
  async sendTyping (peerId: string): Promise<string> {
    const ownerId = uuid().slice(0, 8)
    let typing = this.#typing.get(peerId)

    if (typing) {
      typing.owners.add(ownerId)
      return ownerId
    }

    typing = {
      ticket: '',
      contextToken: '',
      expire: 0,
      timer: null as unknown as NodeJS.Timeout,
      autoStop: null as unknown as NodeJS.Timeout,
      owners: new Set([ownerId]),
    }
    this.#typing.set(peerId, typing)

    const perform = async () => {
      try {
        const contextToken = await state.getContext(this.account.selfId, peerId)
        if (!contextToken) return

        if (!typing!.ticket || typing!.contextToken !== contextToken || Date.now() > typing!.expire) {
          const res = await this.super.getTypingTicket(peerId, contextToken)
          typing!.ticket = res.typing_ticket
          typing!.contextToken = contextToken
          typing!.expire = Date.now() + TYPING_TICKET_TTL
        }
        await this.super.sendTypingState(peerId, typing!.ticket)
      } catch (error) {
        this.logger('error', `发送正在输入状态失败: ${(error as Error).message}`)
      }
    }

    await perform()
    typing.timer = setInterval(perform, TYPING_KEEPALIVE)
    typing.autoStop = setTimeout(() => this.stopTyping(peerId), TYPING_TTL)

    return ownerId
  }

  /** 停止"正在输入"状态 传入ownerId时仅移除对应触发源 */
  async stopTyping (peerId: string, ownerId: string | null = null): Promise<void> {
    const typing = this.#typing.get(peerId)
    if (!typing) return

    if (ownerId) {
      typing.owners.delete(ownerId)
    } else {
      typing.owners.clear()
    }
    if (typing.owners.size > 0) return

    clearInterval(typing.timer)
    clearTimeout(typing.autoStop)
    this.#typing.delete(peerId)

    if (typing.ticket) {
      try {
        await this.super.sendTypingState(peerId, typing.ticket, true)
      } catch { /* 忽略停止失败 */ }
    }
  }
}

/** wxoc 协议 bot 工厂 */
export const createWxocBot = (cfg: BotConfig): WxocBot | undefined => {
  if (!cfg.wxocToken || !cfg.wxocAccountId) {
    logger.warn(`[adapters] wxoc 缺少 wxocToken 或 wxocAccountId 无法创建: ${cfg.wxocNickname || cfg.wxocUserId || ''}`)
    return undefined
  }
  return new WxocBot(cfg)
}
