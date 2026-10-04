import {
  contactDirect,
  contactGuild,
  createDirectMessage,
  createGuildMessage,
  senderDirect,
  senderGuild,
} from 'node-karin'
import { AdapterConvertKarin } from './convert'
import { applyMsgReplace } from '../../utils/msgReplace'
import type { KookBot } from './index'

/** Kook Gateway/WebHook 推送的事件 (经过 eventChannel 剥壳后的 d 字段) */
export interface KookEvent {
  /** 消息类型: 普通消息为数字, 系统消息为字符串 'sys' */
  type: 'sys' | string | number
  channel_type: 'GROUP' | 'PERSON' | string
  target_id: string
  author_id: string
  content: string
  msg_id: string
  msg_seq?: number
  msg_timestamp?: number
  nonce?: string
  extra?: {
    type?: string
    author?: {
      id: string
      username?: string
      nickname?: string
      identify_num?: string
      avatar?: string
    }
    guild_id?: string
    channel_name?: string
    guild_name?: string
    body?: Record<string, any>
    mention?: string[]
    mention_all?: boolean
  }
  [key: string]: any
}

/** 获取发送者信息 (Kook 事件不含角色/性别, 默认 member) */
function senderOf (event: KookEvent) {
  const author = event.extra?.author
  const userId = String(event.author_id)
  const name = author?.nickname || author?.username || userId
  return { userId, name, nick: name }
}

/** 频道消息 (channel_type=GROUP) → Karin 频道消息 */
function GuildMessage (event: KookEvent, bot: KookBot) {
  const messageId = String(event.msg_id)
  // peer=频道(服务器)ID subPeer=子频道ID, name=频道名 subName=子频道名
  const contact = contactGuild(
    String(event.extra?.guild_id || event.target_id),
    String(event.target_id),
    String(event.extra?.guild_name || ''),
    String(event.extra?.channel_name || '')
  )
  const { userId, name } = senderOf(event)
  const sender = senderGuild(userId, 'member', name, undefined, undefined)
  // 入站文本段应用消息正则替换 (如 /命令 → #命令)
  const elements = applyMsgReplace(AdapterConvertKarin(event.content), bot.cfg.msgReplace, bot.cfg.msgReplaceEnable)
  createGuildMessage({
    time: Math.floor((event.msg_timestamp || Date.now()) / 1000),
    eventId: messageId,
    rawEvent: event,
    srcReply: (element) => bot.sendMsg(contact, element),
    bot,
    messageId,
    messageSeq: Number(event.msg_seq || 0),
    elements,
    contact,
    sender,
  })
}

/** 私信消息 (channel_type=PERSON) → Karin 频道私信 */
function DirectMessage (event: KookEvent, bot: KookBot) {
  const messageId = String(event.msg_id)
  // peer=对端用户ID(私信发送目标, /direct-message/create 的 target_id) subPeer=机器人ID(事件 target_id)
  const contact = contactDirect(
    String(event.author_id),
    String(event.target_id),
    senderOf(event).name,
    String(event.extra?.channel_name || '')
  )
  const { userId, name } = senderOf(event)
  const sender = senderDirect(userId, name)
  // 入站文本段应用消息正则替换 (如 /命令 → #命令)
  const elements = applyMsgReplace(AdapterConvertKarin(event.content), bot.cfg.msgReplace, bot.cfg.msgReplaceEnable)
  createDirectMessage({
    time: Math.floor((event.msg_timestamp || Date.now()) / 1000),
    eventId: messageId,
    rawEvent: event,
    srcReply: (element) => bot.sendMsg(contact, element),
    bot,
    messageId,
    messageSeq: Number(event.msg_seq || 0),
    elements,
    contact,
    sender,
    srcGuildId: '',
  })
}

/** 系统消息: 撤回等通知 node-karin 暂无 guild/direct 构造器, 第一版降级为日志 */
function SystemMessage (event: KookEvent, bot: KookBot) {
  const sysType = String(event.extra?.type || 'unknown')
  if (sysType === 'delete_message') {
    const body = event.extra?.body || {}
    bot.logger('info', `[Kook撤回] channel=${String(body.channel_id || event.target_id)} msg=${String(body.msg_id || '')} operator=${String(event.author_id)}`)
    return
  }
  bot.logger('debug', `[Kook系统消息] type=${sysType} ${JSON.stringify(event.extra || {}).slice(0, 200)}`)
}

/** Kook 事件分发 */
export async function EventDispatch (event: KookEvent, bot: KookBot) {
  // 系统消息 (type 为字符串 'sys')
  if (event.type === 'sys') {
    SystemMessage(event, bot)
    return
  }
  // 私信
  if (event.channel_type === 'PERSON') {
    DirectMessage(event, bot)
    return
  }
  // 频道消息
  if (event.channel_type === 'GROUP' && event.target_id && event.author_id && event.msg_id) {
    GuildMessage(event, bot)
    return
  }
  bot.logger('warn', `收到未知 Kook 事件: ${JSON.stringify(event).slice(0, 300)}`)
}