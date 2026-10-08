import {
  contactDirect,
  contactFriend,
  contactGroup,
  contactGuild,
  createDirectMessage,
  createFriendMessage,
  createGroupApplyRequest,
  createGroupMemberAddNotice,
  createGroupMemberDelNotice,
  createGroupMessage,
  createGuildMessage,
  segment,
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
 * QQBot 事件分发 (官方 wiki api-v2):
 *  AT_MESSAGE_CREATE     频道 @ 消息      → guild 场景
 *  MESSAGE_CREATE        频道所有消息     → guild 场景 (开启「接收所有消息」后推送)
 *  DIRECT_MESSAGE_CREATE 频道私信消息     → direct 场景
 *  GROUP_AT_MESSAGE_CREATE 群聊 @ 消息   → group 场景
 *  GROUP_MESSAGE_CREATE  群聊所有消息     → group 场景 (开启「接收所有消息」后推送, content 已去除 @机器人前缀)
 *  C2C_MESSAGE_CREATE    单聊消息         → friend 场景
 * 系统事件:
 *  GROUP_ADD_ROBOT / GROUP_DEL_ROBOT   机器人进群/被移出群
 *  GROUP_MEMBER_ADD / GROUP_MEMBER_REMOVE 群成员增减 (intent 1<<24)
 *  GROUP_JOIN_REQUEST                  加群申请 (机器人须为群管理员)
 *  GROUP_MSG_REJECT / GROUP_MSG_RECEIVE 群主关闭/开启机器人消息接收
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
    case 'GROUP_ADD_ROBOT':
    case 'GROUP_DEL_ROBOT':
    case 'GROUP_MEMBER_ADD':
    case 'GROUP_MEMBER_REMOVE':
      GroupMemberChange(event.type, event.data, bot)
      break
    case 'GROUP_JOIN_REQUEST':
      GroupJoinRequest(event.data, bot)
      break
    case 'GROUP_MSG_REJECT':
      bot.logger('info', `[${event.data?.group_openid || '?'}] 群主已关闭机器人消息接收, 期间无法向该群发送消息`)
      break
    case 'GROUP_MSG_RECEIVE':
      bot.logger('info', `[${event.data?.group_openid || '?'}] 群消息接收状态变动`, event.data)
      break
    case 'INTERACTION_CREATE':
      InteractionCreate(event.data, bot)
      break
    default:
      // 其余事件(互动回调/审核等)暂不处理, 记录日志
      bot.logger('debug', `收到 QQBot 事件: ${event.type}`)
      break
  }
}

/** 群成员变动 → Karin 通知事件 (GROUP_ADD_ROBOT/GROUP_DEL_ROBOT/GROUP_MEMBER_ADD/GROUP_MEMBER_REMOVE) */
function GroupMemberChange (type: string, raw: any, bot: QqBotBot) {
  const data = raw?.data ?? raw
  const groupOpenid = String(data.group_openid || '')
  if (!groupOpenid) return
  const selfId = bot.account.selfId || '0'
  const isRobot = type === 'GROUP_ADD_ROBOT' || type === 'GROUP_DEL_ROBOT'
  const targetId = isRobot ? selfId : String(data.member_openid || data.user_openid || '')
  const time = parseTime(data.timestamp)
  const contact = contactGroup(groupOpenid)
  const srcReply = (element: any) => bot.sendMsg(contact, element)
  if (type === 'GROUP_ADD_ROBOT' || type === 'GROUP_MEMBER_ADD') {
    createGroupMemberAddNotice({
      bot,
      eventId: `notice:add:${time}:${targetId}`,
      rawEvent: data,
      time,
      contact,
      sender: senderGroup(targetId),
      srcReply,
      content: { operatorId: '0', targetId, type: 'approve' },
    })
  } else {
    const kicked = Boolean(data.operator_openid) && !isRobot
    createGroupMemberDelNotice({
      bot,
      eventId: `notice:del:${time}:${targetId}`,
      rawEvent: data,
      time,
      contact,
      sender: senderGroup(targetId),
      srcReply,
      content: { operatorId: String(data.operator_openid || '0'), targetId, type: isRobot ? 'kickBot' : kicked ? 'kick' : 'leave' },
    })
  }
}

/** 加群申请 → Karin 请求事件 (GROUP_JOIN_REQUEST, 机器人须为群管理员; flag=join_request_id) */
function GroupJoinRequest (raw: any, bot: QqBotBot) {
  const data = raw?.data ?? raw
  const groupOpenid = String(data.group_openid || '')
  const flag = String(data.join_request_id || '')
  const applierId = String(data.member_openid || data.union_openid || '')
  if (!groupOpenid || !flag) return
  const time = parseTime(data.apply_at || data.timestamp)
  const contact = contactGroup(groupOpenid)
  createGroupApplyRequest({
    bot,
    time,
    contact,
    rawEvent: data,
    subEvent: 'groupApply',
    eventId: `request:${flag}`,
    sender: senderGroup(applierId, 'unknown', String(data.username || applierId)),
    srcReply: (element) => bot.sendMsg(contact, element),
    content: {
      applierId,
      inviterId: String(data.invited_by || ''),
      reason: String(data.verify_info?.verify_message || data.risk_tips || ''),
      flag,
      groupId: groupOpenid,
    },
  })
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
  // karin Sender 结构无 avatar 字段, 此前误传到 area (地区) 参数位, 已移除
  const sender = senderGroup(memberId, 'member', name || memberId)
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
  const sender = senderFriend(openid, name)
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

/**
 * 按钮/快捷菜单点击回调 → Karin 消息事件 (INTERACTION_CREATE, intent 1<<26):
 * 官方 adapter-qqbot 同款做法:
 *  - type=11 (消息按钮) / 12 (快捷菜单) 必须回执 PUT /interactions/{id} (3s 内), 否则客户端一直 loading 直到超时
 *  - ACK 结束后才投递业务层, 避免业务回复请求抢在 ACK 前占用回调窗口
 *  - interactionId 可作被动消息 msg_id (群聊实测可能被拒绝 40034025, 发送侧已带降级重试)
 * 把按钮 data (如 #qbot登录) 转为一条消息事件, 让插件指令正常触发。
 */
function InteractionCreate (raw: any, bot: QqBotBot) {
  const data = raw?.data ?? raw
  // WS Dispatch 外层 id 形如 "INTERACTION_CREATE:uuid", ACK 需要事件体内的 d.id, 缺失时剥前缀兜底
  const dispatchId = String(raw?.id || '')
  const interactionId = String(data.id || dispatchId.replace(/^INTERACTION_CREATE:/, ''))
  const type = Number(data.type ?? 0)
  // 仅按钮/菜单点击需要回执, 其他类型 (消息反馈/清空会话/授权等) 无需回应
  const needAck = (type === 11 || type === 12) && Boolean(interactionId)
  const emit = () => {
    const buttonData = String(data.data?.resolved?.button_data || '')
    if (!buttonData) return
    const chatType = Number(data.chat_type ?? 0)
    const time = parseTime(data.timestamp)
    // elements 只放 button_data 文本, 避免多余段污染 e.msg 导致 command 无法精确匹配
    const elements = [segment.text(buttonData)]
    // 频道场景
    if (chatType === 0) {
      const guildId = String(data.guild_id || '')
      const channelId = String(data.channel_id || '')
      if (!guildId || !channelId) return
      const userId = String(data.data?.resolved?.user_id || '')
      const contact = contactGuild(guildId, channelId)
      createGuildMessage({
        time,
        eventId: dispatchId || interactionId,
        rawEvent: data,
        srcReply: (element) => bot.sendMsg(contact, element),
        bot,
        messageId: interactionId,
        messageSeq: 0,
        elements,
        contact,
        sender: senderGuild(userId, 'unknown', userId || '用户', undefined, undefined),
      })
      return
    }
    // 群聊场景: 点击者用 group_member_openid
    if (chatType === 1) {
      const groupOpenid = String(data.group_openid || '')
      const memberId = String(data.group_member_openid || '')
      if (!groupOpenid || !memberId) return
      const contact = contactGroup(groupOpenid)
      createGroupMessage({
        time,
        eventId: dispatchId || interactionId,
        rawEvent: data,
        srcReply: (element) => bot.sendMsg(contact, element),
        bot,
        messageId: interactionId,
        messageSeq: 0,
        elements,
        contact,
        sender: senderGroup(memberId, 'unknown', memberId),
      })
      return
    }
    // 单聊场景: 点击者用 user_openid
    if (chatType === 2) {
      const openid = String(data.user_openid || '')
      if (!openid) return
      const contact = contactFriend(openid, '好友')
      createFriendMessage({
        time,
        eventId: dispatchId || interactionId,
        rawEvent: data,
        srcReply: (element) => bot.sendMsg(contact, element),
        bot,
        messageId: interactionId,
        messageSeq: 0,
        elements,
        contact,
        sender: senderFriend(openid, '好友'),
      })
      return
    }
    bot.logger('debug', `[INTERACTION] 未识别的 chat_type=${chatType}`)
  }
  if (!needAck) {
    emit()
    return
  }
  // 先 ACK 再投递业务层 (官方 onInteraction 同款)
  bot.super.putInteraction(interactionId, 0)
    .catch(() => { /* ack 失败仅忽略, 官方允许失败后照常投递 */ })
    .finally(emit)
}