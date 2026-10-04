import {
  contactDirect,
  contactFriend,
  contactGroup,
  contactGuild,
  createDirectMessage,
  createFriendMessage,
  createGroupMessage,
  createGuildMessage,
  senderDirect,
  senderFriend,
  senderGroup,
  senderGuild,
} from 'node-karin'
import { AdapterConvertKarin } from './convert'
import { applyMsgReplace } from '../../utils/msgReplace'
import type { QqBotBot } from './index'

/** QQBot 规范化事件 (由 eventChannel 输出 { type, data }) */
export interface QqBotEvent {
  type: string
  data: any
}

/**
 * QQBot 事件分发:
 *  AT_MESSAGE_CREATE     频道 @ 消息      → guild 场景
 *  MESSAGE_CREATE        频道所有消息     → guild 场景 (开启「接收所有消息」后推送)
 *  DIRECT_MESSAGE_CREATE 频道私信消息     → direct 场景
 *  GROUP_AT_MESSAGE_CREATE 群聊 @ 消息   → group 场景
 *  GROUP_MESSAGE_CREATE  群聊所有消息     → group 场景 (开启「接收所有消息」后推送, content 已去除 @机器人前缀)
 *  C2C_MESSAGE_CREATE    单聊消息         → friend 场景
 */
export async function EventDispatch (event: QqBotEvent, bot: QqBotBot) {
  switch (event.type) {
    case 'AT_MESSAGE_CREATE':
    case 'MESSAGE_CREATE':
      ChannelMessage(event.data, bot)
      break
    case 'DIRECT_MESSAGE_CREATE':
      DMsMessage(event.data, bot)
      break
    case 'GROUP_AT_MESSAGE_CREATE':
    case 'GROUP_MESSAGE_CREATE':
      GroupMessage(event.data, bot)
      break
    case 'C2C_MESSAGE_CREATE':
      C2CMessage(event.data, bot)
      break
    default:
      // 其余事件(成员变动/审核等)暂不处理, 第一版记录日志
      bot.logger('debug', `收到 QQBot 事件: ${event.type}`)
      break
  }
}

/** 时间戳(ISO 字符串或秒/毫秒) → Unix 秒 */
function parseTime (ts: string | number | undefined): number {
  if (!ts) return Math.floor(Date.now() / 1000)
  if (typeof ts === 'number') {
    // 毫秒级时间戳(13位)转秒; 否则按秒处理
    return Math.floor(ts > 1e11 ? ts / 1000 : ts)
  }
  const d = new Date(ts)
  return isNaN(d.getTime()) ? Math.floor(Date.now() / 1000) : Math.floor(d.getTime() / 1000)
}

/** 取消息序号 */
function seqOf (data: any): number {
  const n = Number(data.msg_seq ?? data.seq ?? 0)
  return isNaN(n) ? 0 : n
}

/** 频道 @ 消息 → Karin 频道消息 (AT_MESSAGE_CREATE) */
function ChannelMessage (raw: any, bot: QqBotBot) {
  const data = raw?.data ?? raw
  const messageId = String(data.id)
  if (!messageId || !data.channel_id) return
  // peer=服务器ID subPeer=子频道ID
  const contact = contactGuild(String(data.guild_id), String(data.channel_id))
  const author = data.author || {}
  const userId = String(author.id || '')
  const name = author.username || userId || '未知'
  const sender = senderGuild(userId, 'member', name, undefined, undefined)
  // 入站文本段应用消息正则替换 (如 /命令 → #命令)
  const elements = applyMsgReplace(AdapterConvertKarin(data.content, data), bot.cfg.msgReplace, bot.cfg.msgReplaceEnable)
  createGuildMessage({
    time: parseTime(data.timestamp),
    eventId: messageId,
    rawEvent: data,
    srcReply: (element) => bot.sendMsg(contact, element),
    bot,
    messageId,
    messageSeq: seqOf(data),
    elements,
    contact,
    sender,
  })
}

/** 频道私信消息 → Karin 频道私信 (DIRECT_MESSAGE_CREATE) */
function DMsMessage (raw: any, bot: QqBotBot) {
  const data = raw?.data ?? raw
  const messageId = String(data.id)
  if (!messageId || !data.guild_id) return
  const author = data.author || {}
  const userId = String(author.id || '')
  const name = author.username || userId || '未知'
  // peer=私信会话ID(guild_id, API 回复目标) subId=来源子频道ID
  const contact = contactDirect(String(data.guild_id), String(data.channel_id || ''), name, String(data.srcGuildId || ''))
  const sender = senderDirect(userId, name, undefined, undefined, userId, undefined)
  // 入站文本段应用消息正则替换 (如 /命令 → #命令)
  const elements = applyMsgReplace(AdapterConvertKarin(data.content, data), bot.cfg.msgReplace, bot.cfg.msgReplaceEnable)
  createDirectMessage({
    time: parseTime(data.timestamp),
    eventId: messageId,
    rawEvent: data,
    srcReply: (element) => bot.sendMsg(contact, element),
    bot,
    messageId,
    messageSeq: seqOf(data),
    elements,
    contact,
    sender,
    srcGuildId: String(data.srcGuildId || ''),
  })
}

/** 群聊消息 → Karin 群消息 (GROUP_AT_MESSAGE_CREATE) */
function GroupMessage (raw: any, bot: QqBotBot) {
  const data = raw?.data ?? raw
  const messageId = String(data.id)
  const groupOpenid = String(data.group_openid)
  if (!messageId || !groupOpenid) return
  const author = data.author || {}
  // 群消息发送者用 member_openid, 私聊用 user_openid
  const memberId = String(author.member_openid || author.user_openid || '')
  const name = author.username || memberId
  const contact = contactGroup(groupOpenid, String(data.group_name || ''))
  const sender = senderGroup(memberId, 'member', name || memberId, undefined, undefined, undefined, author.avatar)
  // 入站文本段应用消息正则替换 (如 /命令 → #命令)
  const elements = applyMsgReplace(AdapterConvertKarin(data.content, data), bot.cfg.msgReplace, bot.cfg.msgReplaceEnable)
  createGroupMessage({
    time: parseTime(data.timestamp),
    eventId: messageId,
    rawEvent: data,
    srcReply: (element) => bot.sendMsg(contact, element),
    bot,
    messageId,
    messageSeq: seqOf(data),
    elements,
    contact,
    sender,
  })
}

/** 单聊消息 → Karin 好友消息 (C2C_MESSAGE_CREATE) */
function C2CMessage (raw: any, bot: QqBotBot) {
  const data = raw?.data ?? raw
  const messageId = String(data.id)
  const author = data.author || {}
  const openid = String(author.user_openid || '')
  if (!messageId || !openid) return
  const name = author.username || '好友' || openid
  const contact = contactFriend(openid, name)
  const sender = senderFriend(openid, name, undefined)
  // 入站文本段应用消息正则替换 (如 /命令 → #命令)
  const elements = applyMsgReplace(AdapterConvertKarin(data.content, data), bot.cfg.msgReplace, bot.cfg.msgReplaceEnable)
  createFriendMessage({
    time: parseTime(data.timestamp),
    eventId: messageId,
    rawEvent: data,
    srcReply: (element) => bot.sendMsg(contact, element),
    bot,
    messageId,
    messageSeq: seqOf(data),
    elements,
    contact,
    sender,
  })
}