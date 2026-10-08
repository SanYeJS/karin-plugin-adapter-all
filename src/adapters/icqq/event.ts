import type { GroupMessageEvent, PrivateMessageEvent, FriendPokeEvent, GroupPokeEvent, GroupMuteEvent, GroupRecallEvent, FriendRecallEvent, MemberIncreaseEvent, MemberDecreaseEvent, GroupAdminEvent, GroupSignEvent, GroupTransferEvent, FriendRequestEvent, GroupRequestEvent, GroupInviteEvent } from 'icqq'
import {
  contactFriend,
  contactGroup,
  contactGroupTemp,
  createFriendMessage,
  createGroupAdminChangedNotice,
  createGroupApplyRequest,
  createGroupFileUploadedNotice,
  createGroupInviteRequest,
  createGroupMemberAddNotice,
  createGroupMemberBanNotice,
  createGroupMemberDelNotice,
  createGroupMessage,
  createGroupMessageReactionNotice,
  createGroupPokeNotice,
  createGroupRecallNotice,
  createGroupTempMessage,
  createGroupWholeBanNotice,
  createPrivateApplyRequest,
  createPrivateFileUploadedNotice,
  createPrivatePokeNotice,
  createPrivateRecallNotice,
  senderFriend,
  senderGroup,
  senderGroupTemp,
} from 'node-karin'
import { AdapterConvertKarin } from './convert'
import type { IcqqBot } from './index'

/** 消息事件 (client.on('message') 懒加载全部消息) */
export async function dispatchMessage (e: any, bot: IcqqBot) {
  if (e.message_type === 'group') {
    await handleGroupMessage(e as GroupMessageEvent, bot)
  } else if (e.message_type === 'private') {
    await handlePrivateMessage(e as PrivateMessageEvent, bot)
  } else {
    bot.logger('debug', `[消息] 忽略不支持的消息类型: ${(e as any).message_type}`)
  }
}

/** 群消息 → Karin 群消息事件 */
async function handleGroupMessage (e: GroupMessageEvent, bot: IcqqBot) {
  const contact = contactGroup(String(e.group_id), e.group_name)
  const s = e.sender
  const sender = senderGroup(
    String(s.user_id),
    s.role,
    s.nickname,
    s.sex,
    s.age,
    s.card,
    undefined,
    s.level,
    s.title,
  )
  const elements = await AdapterConvertKarin(e, bot)
  createGroupMessage({
    time: e.time,
    eventId: e.message_id,
    rawEvent: e,
    srcReply: (element) => bot.sendMsg(contact, element),
    bot,
    messageId: e.message_id,
    messageSeq: e.seq,
    elements,
    contact,
    sender,
  })
}

/** 私聊消息 → Karin 好友消息 / 群临时会话消息 */
async function handlePrivateMessage (e: PrivateMessageEvent, bot: IcqqBot) {
  const elements = await AdapterConvertKarin(e, bot)
  if (e.sub_type === 'friend') {
    const contact = contactFriend(String(e.from_id), e.sender.nickname)
    const sender = senderFriend(String(e.from_id), e.sender.nickname)
    createFriendMessage({
      time: e.time,
      eventId: e.message_id,
      rawEvent: e,
      srcReply: (element) => bot.sendMsg(contact, element),
      bot,
      messageId: e.message_id,
      messageSeq: e.seq,
      elements,
      contact,
      sender,
    })
  } else if (e.sub_type === 'group' || e.sub_type === 'other') {
    // 群临时会话: from_id 为发送者, sender.group_id 为来源群
    const groupId = e.sender.group_id
    if (!groupId) {
      bot.logger('debug', `[消息] 临时会话缺少群号, 忽略: ${e.message_id}`)
      return
    }
    const contact = contactGroupTemp(String(groupId), String(e.from_id))
    const sender = senderGroupTemp(String(e.from_id))
    createGroupTempMessage({
      time: e.time,
      eventId: e.message_id,
      rawEvent: e,
      srcReply: (element) => bot.sendMsg(contact, element),
      bot,
      messageId: e.message_id,
      messageSeq: e.seq,
      elements,
      contact,
      sender,
    })
  }
  // sub_type 'self' (我的设备) 忽略
}

/** 通知事件 (client.on('notice')) */
export async function dispatchNotice (e: any, bot: IcqqBot) {
  const time = Date.now()
  if (e.notice_type === 'friend') {
    switch (e.sub_type) {
      case 'recall': {
        const ev = e as FriendRecallEvent
        const userId = String(ev.user_id)
        const contact = contactFriend(userId)
        createPrivateRecallNotice({
          time: Date.now(),
          eventId: `notice:${ev.message_id}`,
          rawEvent: e,
          contact,
          sender: senderFriend(userId),
          srcReply: (element) => bot.sendMsg(contact, element),
          bot,
          content: {
            operatorId: String(ev.operator_id),
            messageId: ev.message_id || '',
            tips: '',
          },
        })
        break
      }
      case 'poke': {
        const ev = e as FriendPokeEvent
        const userId = String(ev.operator_id)
        const contact = contactFriend(userId)
        createPrivatePokeNotice({
          time,
          eventId: `notice:${time}`,
          rawEvent: e,
          bot,
          contact,
          sender: senderFriend(userId),
          srcReply: (element) => bot.sendMsg(contact, element),
          content: {
            operatorId: userId,
            targetId: String(ev.target_id),
            action: ev.action,
            actionImage: '',
            suffix: ev.suffix,
          },
        })
        break
      }
      case 'increase':
        bot.logger('info', `[通知] 新增好友: ${(e as any).user_id} (${(e as any).nickname})`)
        break
      case 'decrease':
        bot.logger('info', `[通知] 好友减少: ${(e as any).user_id} (${(e as any).nickname})`)
        break
      default:
        bot.logger('debug', `[通知] 未知好友通知: ${JSON.stringify(e)}`)
    }
    return
  }
  if (e.notice_type === 'group') {
    const contact = contactGroup(String(e.group_id), (e as any).group?.name)
    switch (e.sub_type) {
      case 'increase': {
        const ev = e as MemberIncreaseEvent
        const userId = String(ev.user_id)
        createGroupMemberAddNotice({
          bot,
          eventId: `notice:${time}`,
          rawEvent: e,
          time,
          contact,
          sender: senderGroup(userId),
          srcReply: (element) => bot.sendMsg(contact, element),
          content: {
            operatorId: String(ev.user_id),
            targetId: userId,
            type: 'approve',
          },
        })
        break
      }
      case 'decrease': {
        const ev = e as MemberDecreaseEvent
        const userId = String(ev.user_id)
        const operatorId = String(ev.operator_id)
        createGroupMemberDelNotice({
          bot,
          eventId: `notice:${time}`,
          rawEvent: e,
          time,
          contact,
          sender: senderGroup(userId),
          srcReply: (element) => bot.sendMsg(contact, element),
          content: {
            operatorId,
            targetId: userId,
            type: operatorId === userId ? 'leave' : (ev.dismiss ? 'kickBot' : 'kick'),
          },
        })
        break
      }
      case 'recall': {
        const ev = e as GroupRecallEvent
        createGroupRecallNotice({
          time: Date.now(),
          eventId: `notice:${ev.message_id}`,
          rawEvent: e,
          contact,
          sender: senderGroup(String(ev.operator_id)),
          srcReply: (element) => bot.sendMsg(contact, element),
          bot,
          content: {
            operatorId: String(ev.operator_id),
            messageId: ev.message_id || '',
            targetId: String(ev.user_id),
            tip: '',
          },
        })
        break
      }
      case 'admin': {
        const ev = e as GroupAdminEvent
        createGroupAdminChangedNotice({
          bot,
          eventId: `notice:${time}`,
          rawEvent: e,
          time,
          contact,
          sender: senderGroup(String(ev.user_id)),
          srcReply: (element) => bot.sendMsg(contact, element),
          content: {
            targetId: String(ev.user_id),
            isAdmin: ev.set,
          },
        })
        break
      }
      case 'ban': {
        const ev = e as GroupMuteEvent
        const userId = String(ev.user_id)
        createGroupMemberBanNotice({
          bot,
          eventId: `notice:${time}`,
          rawEvent: e,
          time,
          contact,
          sender: senderGroup(userId),
          srcReply: (element) => bot.sendMsg(contact, element),
          content: {
            operatorId: String(ev.operator_id),
            targetId: userId,
            duration: ev.duration,
            isBan: ev.duration > 0,
          },
        })
        break
      }
      case 'poke': {
        const ev = e as GroupPokeEvent
        const userId = String(ev.operator_id)
        createGroupPokeNotice({
          time,
          eventId: `notice:${time}`,
          rawEvent: e,
          bot,
          contact,
          sender: senderGroup(userId),
          srcReply: (element) => bot.sendMsg(contact, element),
          content: {
            operatorId: userId,
            targetId: String(ev.target_id),
            action: ev.action,
            actionImage: '',
            suffix: ev.suffix,
          },
        })
        break
      }
      case 'reaction': {
        // icqq 未导出 GroupReactionEvent 类型, 用局部结构
        const ev = e as { user_id: number; group_id: number; id: number; set: boolean; seq: number }
        createGroupMessageReactionNotice({
          bot,
          eventId: `notice:${time}`,
          rawEvent: e,
          time,
          contact,
          sender: senderGroup(String(ev.user_id)),
          srcReply: (element) => bot.sendMsg(contact, element),
          content: {
            count: 1,
            faceId: Number(ev.id),
            isSet: ev.set,
            messageId: bot.encodeQuoteMsgId(String(ev.group_id), ev.seq),
          },
        })
        break
      }
      case 'sign': {
        const ev = e as GroupSignEvent
        bot.logger('info', `[通知] 群签到: ${ev.nickname} (${ev.sign_text})`)
        break
      }
      case 'transfer': {
        const ev = e as GroupTransferEvent
        bot.logger('info', `[通知] 群转让: ${ev.operator_id} → ${ev.user_id}`)
        break
      }
      default:
        bot.logger('debug', `[通知] 未知群通知: ${JSON.stringify(e)}`)
    }
    return
  }
  bot.logger('debug', `[通知] 未知通知: ${JSON.stringify(e)}`)
}

/** 申请事件 (client.on('request')) */
export async function dispatchRequest (e: any, bot: IcqqBot) {
  const time = Date.now()
  if (e.request_type === 'friend') {
    const ev = e as FriendRequestEvent
    const userId = String(ev.user_id)
    const contact = contactFriend(userId)
    createPrivateApplyRequest({
      bot,
      time,
      contact,
      rawEvent: e,
      subEvent: 'friendApply',
      eventId: `request:${ev.flag}`,
      sender: senderFriend(userId, ev.nickname),
      srcReply: (element) => bot.sendMsg(contact, element),
      content: {
        applierId: userId,
        message: ev.comment,
        flag: ev.flag,
      },
    })
    return
  }
  if (e.request_type === 'group') {
    const contact = contactGroup(String(e.group_id), e.group_name)
    if (e.sub_type === 'invite') {
      const ev = e as GroupInviteEvent
      const inviterId = String(ev.user_id)
      createGroupInviteRequest({
        bot,
        time,
        contact,
        rawEvent: e,
        subEvent: 'groupInvite',
        eventId: `request:${ev.flag}`,
        sender: senderGroup(inviterId, ev.role),
        srcReply: (element) => bot.sendMsg(contact, element),
        content: {
          inviterId,
          flag: ev.flag,
        },
      })
    } else {
      const ev = e as GroupRequestEvent
      const applierId = String(ev.user_id)
      createGroupApplyRequest({
        bot,
        time,
        contact,
        rawEvent: e,
        subEvent: 'groupApply',
        eventId: `request:${ev.flag}`,
        sender: senderGroup(applierId, 'unknown', ev.nickname),
        srcReply: (element) => bot.sendMsg(contact, element),
        content: {
          applierId,
          inviterId: ev.inviter_id ? String(ev.inviter_id) : '',
          reason: ev.comment,
          flag: ev.flag,
          groupId: String(ev.group_id),
        },
      })
    }
    return
  }
  bot.logger('debug', `[申请] 未知申请: ${JSON.stringify(e)}`)
}