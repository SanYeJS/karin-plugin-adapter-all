import type { Event } from '@saltify/milky-types'
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
import type { MilkyBot } from './index'

/** 消息事件 → Karin 消息 */
async function createMessage (event: Extract<Event, { event_type: 'message_receive' }>, bot: MilkyBot) {
  const data = event.data
  const messageId = bot.super.encodeMsgId(data.message_scene, data.peer_id, data.message_seq)
  const elements = await AdapterConvertKarin(event.data, bot)
  if (data.message_scene === 'group') {
    const contact = contactGroup(data.peer_id + '', data.group.group_name)
    const MInfo = data.group_member
    const sender = senderGroup(MInfo.user_id + '',
      MInfo.role,
      MInfo.nickname,
      MInfo.sex,
      0,
      MInfo.card,
      undefined,
      MInfo.level,
      MInfo.title
    )
    createGroupMessage({
      time: event.time,
      eventId: messageId,
      rawEvent: event,
      srcReply: (element) => bot.sendMsg(contact, element),
      bot,
      messageId,
      messageSeq: data.message_seq,
      elements,
      contact,
      sender
    })
  } else if (data.message_scene === 'friend') {
    const FInfo = data.friend
    const contact = contactFriend(data.peer_id + '', FInfo.nickname)
    const sender = senderFriend(FInfo.user_id + '',
      FInfo.nickname,
      FInfo.sex
    )
    createFriendMessage({
      time: event.time,
      eventId: messageId,
      rawEvent: event,
      srcReply: (element) => bot.sendMsg(contact, element),
      bot,
      messageId,
      messageSeq: data.message_seq,
      elements,
      contact,
      sender
    })
  } else if (data.message_scene === 'temp') {
    const TInfo = data.group
    const contact = contactGroupTemp(TInfo?.group_id + '', data.peer_id + '', TInfo?.group_name)
    const sender = senderGroupTemp(data.peer_id + '')
    createGroupTempMessage({
      time: event.time,
      eventId: messageId,
      rawEvent: event,
      srcReply: (element) => bot.sendMsg(contact, element),
      bot,
      messageId,
      messageSeq: data.message_seq,
      elements,
      contact,
      sender
    })
  }
}

/** 消息撤回通知 */
function RecallNotice (event: Extract<Event, { event_type: 'message_recall' }>, bot: MilkyBot) {
  const data = event.data
  const messageId = bot.super.encodeMsgId(data.message_scene, data.peer_id, data.message_seq)
  if (data.message_scene === 'friend') {
    const contact = contactFriend(data.peer_id + '')
    const sender = senderFriend(data.peer_id + '')
    createPrivateRecallNotice({
      time: event.time,
      eventId: 'notice:' + event.time,
      rawEvent: event,
      contact,
      sender,
      srcReply: elements => bot.sendMsg(contact, elements),
      bot,
      content: {
        operatorId: data.operator_id + '',
        messageId,
        tips: data.display_suffix
      }
    })
  } else if (data.message_scene === 'group') {
    const contact = contactGroup(data.peer_id + '')
    const sender = senderGroup(data.operator_id + '')
    createGroupRecallNotice({
      time: event.time,
      eventId: 'notice:' + event.time,
      rawEvent: event,
      contact,
      sender,
      srcReply: elements => bot.sendMsg(contact, elements),
      bot,
      content: {
        operatorId: data.operator_id + '',
        messageId,
        targetId: data.sender_id + '',
        tip: data.display_suffix
      }
    })
  }
}

/** 好友文件上传通知 */
function FriendFileUpload (event: Extract<Event, { event_type: 'friend_file_upload' }>, bot: MilkyBot) {
  const contact = contactFriend(event.data.user_id + '')
  createPrivateFileUploadedNotice({
    time: event.time,
    eventId: 'notice' + event.time,
    contact,
    rawEvent: event,
    sender: senderFriend(event.data.user_id + ''),
    srcReply: (elements) => bot.sendMsg(contact, elements),
    bot,
    content: {
      operatorId: (event.data.is_self ? event.self_id : event.data.user_id) + '',
      fid: event.data.file_id,
      subId: 0,
      name: event.data.file_name,
      size: event.data.file_size,
      expireTime: 0,
      url: async () => { return await bot.getFileUrl(contact, event.data.file_id) },
    }
  })
}

/** 好友戳一戳 */
function FriendPoke (event: Extract<Event, { event_type: 'friend_nudge' }>, bot: MilkyBot) {
  const userId = event.data.user_id + ''
  const contact = contactFriend(userId)
  createPrivatePokeNotice({
    eventId: `notice:${event.time}`,
    rawEvent: event,
    bot,
    time: event.time,
    contact,
    sender: senderFriend(event.data.is_self_send ? event.self_id + '' : userId),
    srcReply: (elements) => bot.sendMsg(contact, elements),
    content: {
      operatorId: event.data.is_self_send ? event.self_id + '' : userId,
      targetId: event.data.is_self_receive ? event.self_id + '' : userId,
      action: event.data.display_action,
      actionImage: event.data.display_action_img_url,
      suffix: event.data.display_suffix
    }
  })
}

/** 群管理变更 */
function GroupAdminChange (event: Extract<Event, { event_type: 'group_admin_change' }>, bot: MilkyBot) {
  const contact = contactGroup(event.data.group_id + '')
  createGroupAdminChangedNotice({
    bot,
    eventId: `notice:${event.time}`,
    rawEvent: event,
    time: event.time,
    contact,
    sender: senderGroup(event.data.operator_id + ''),
    srcReply: (elements) => bot.sendMsg(contact, elements),
    content: {
      targetId: event.data.user_id + '',
      isAdmin: event.data.is_set,
    }
  })
}

/** 群成员增加 */
function GroupMemberIncrease (event: Extract<Event, { event_type: 'group_member_increase' }>, bot: MilkyBot) {
  const contact = contactGroup(event.data.group_id + '')
  const userId = event.data.user_id + ''
  createGroupMemberAddNotice({
    bot,
    eventId: `notice:${event.time}`,
    rawEvent: event,
    time: event.time,
    contact,
    sender: senderGroup(userId),
    srcReply: (elements) => bot.sendMsg(contact, elements),
    content: {
      operatorId: event.data.operator_id + '',
      targetId: userId,
      type: 'approve'
    }
  })
}

/** 群成员减少 */
function GroupMemberDecrease (event: Extract<Event, { event_type: 'group_member_decrease' }>, bot: MilkyBot) {
  const contact = contactGroup(event.data.group_id + '')
  const userId = event.data.user_id + ''
  createGroupMemberDelNotice({
    bot,
    eventId: `notice:${event.time}`,
    rawEvent: event,
    time: event.time,
    contact,
    sender: senderGroup(userId),
    srcReply: (elements) => bot.sendMsg(contact, elements),
    content: {
      operatorId: String(event.data.operator_id || ''),
      targetId: userId,
      type: event.data.operator_id ? 'kick' : 'leave'
    }
  })
}

/** 群消息表情回应 */
function GroupMessageReaction (event: Extract<Event, { event_type: 'group_message_reaction' }>, bot: MilkyBot) {
  const contact = contactGroup(event.data.group_id + '')
  createGroupMessageReactionNotice({
    bot,
    eventId: `notice:${event.time}`,
    rawEvent: event,
    time: event.time,
    contact,
    sender: senderGroup(event.data.user_id + ''),
    srcReply: (elements) => bot.sendMsg(contact, elements),
    content: {
      count: 1,
      faceId: +event.data.face_id,
      isSet: event.data.is_add,
      messageId: bot.super.encodeMsgId('group', +contact.peer, event.data.message_seq),
    }
  })
}

/** 群成员禁言 */
function GroupMute (event: Extract<Event, { event_type: 'group_mute' }>, bot: MilkyBot) {
  const contact = contactGroup(event.data.group_id + '')
  const userId = event.data.user_id + ''
  createGroupMemberBanNotice({
    bot,
    eventId: `notice:${event.time}`,
    rawEvent: event,
    time: event.time,
    contact,
    sender: senderGroup(userId),
    srcReply: (elements) => bot.sendMsg(contact, elements),
    content: {
      operatorId: String(event.data.operator_id),
      targetId: userId,
      duration: event.data.duration,
      isBan: event.data.duration > 0,
    }
  })
}

/** 全员禁言 */
function GroupWholeMute (event: Extract<Event, { event_type: 'group_whole_mute' }>, bot: MilkyBot) {
  const contact = contactGroup(event.data.group_id + '')
  const userId = event.data.operator_id + ''
  createGroupWholeBanNotice({
    bot,
    eventId: `notice:${event.time}`,
    rawEvent: event,
    time: event.time,
    contact,
    sender: senderGroup(userId),
    srcReply: (elements) => bot.sendMsg(contact, elements),
    content: {
      operatorId: userId,
      isBan: event.data.is_mute
    }
  })
}

/** 群戳一戳 */
function GroupPoke (event: Extract<Event, { event_type: 'group_nudge' }>, bot: MilkyBot) {
  const userId = event.data.sender_id + ''
  const contact = contactGroup(event.data.group_id + '')
  createGroupPokeNotice({
    eventId: `notice:${event.time}`,
    rawEvent: event,
    bot,
    time: Date.now(),
    contact,
    sender: senderGroup(userId),
    srcReply: (elements) => bot.sendMsg(contact, elements),
    content: {
      operatorId: userId,
      targetId: event.data.receiver_id + '',
      action: event.data.display_action,
      actionImage: event.data.display_action_img_url,
      suffix: event.data.display_suffix
    }
  })
}

/** Bot 掉线 */
function BotOffline (event: Extract<Event, { event_type: 'bot_offline' }>, bot: MilkyBot) {
  bot.logger('warn', `[Bot离线] 原因: ${event.data.reason}`)
  bot.__unregisterBot()
}

/** 会话置顶变更 */
function PeerPinChange (event: Extract<Event, { event_type: 'peer_pin_change' }>, bot: MilkyBot) {
  bot.logger('debug', `[会话置顶变更] scene=${event.data.message_scene} peer=${event.data.peer_id} pinned=${event.data.is_pinned}`)
}

/** 群精华消息变更 */
function GroupEssenceMessageChange (event: Extract<Event, { event_type: 'group_essence_message_change' }>, bot: MilkyBot) {
  bot.logger('debug', `[群精华消息变更] group=${event.data.group_id} seq=${event.data.message_seq} operator=${event.data.operator_id} isSet=${event.data.is_set}`)
}

/** 群名变更 */
function GroupNameChange (event: Extract<Event, { event_type: 'group_name_change' }>, bot: MilkyBot) {
  bot.logger('info', `[群名变更] group=${event.data.group_id} newName=${event.data.new_group_name} operator=${event.data.operator_id}`)
}

/** 群文件上传 */
function GroupFileUpload (event: Extract<Event, { event_type: 'group_file_upload' }>, bot: MilkyBot) {
  const userId = event.data.user_id + ''
  const contact = contactGroup(event.data.group_id + '')
  createGroupFileUploadedNotice({
    eventId: `notice:${event.time}`,
    rawEvent: event,
    bot,
    time: Date.now(),
    contact,
    sender: senderGroup(userId),
    srcReply: (elements) => bot.sendMsg(contact, elements),
    content: {
      fid: event.data.file_id,
      subId: 0,
      name: event.data.file_name,
      size: event.data.file_size,
      expireTime: 0,
      url: async () => { return await bot.getFileUrl(contact, event.data.file_id) },
    }
  })
}

/** 好友申请 */
function FriendRequest (event: Extract<Event, { event_type: 'friend_request' }>, bot: MilkyBot) {
  const userId = event.data.initiator_id + ''
  const contact = contactFriend(userId)
  createPrivateApplyRequest({
    bot,
    time: event.time,
    contact,
    rawEvent: event,
    subEvent: 'friendApply',
    eventId: `request:${event.time}`,
    sender: senderFriend(userId),
    srcReply: (elements) => bot.sendMsg(contact, elements),
    content: {
      applierId: userId,
      message: event.data.comment,
      flag: event.data.initiator_uid
    }
  })
}

/** 群申请(人/邀请) */
async function GroupJoinRequest (event: Extract<Event, { event_type: 'group_join_request' | 'group_invited_join_request' }>, bot: MilkyBot) {
  const groupId = String(event.data.group_id)
  const contact = contactGroup(groupId)
  const isInvited = event.event_type === 'group_invited_join_request'
  const applierId = isInvited && 'target_user_id' in event.data
    ? String(event.data.target_user_id)
    : String(event.data.initiator_id)
  const inviterId = isInvited ? String(event.data.initiator_id) : ''
  const Info = await bot.getStrangerInfo(applierId)

  createGroupApplyRequest({
    bot,
    time: event.time,
    contact,
    rawEvent: event,
    subEvent: 'groupApply',
    eventId: `request:${event.time}`,
    sender: senderGroup(applierId, 'unknown', Info.nick, Info.sex, Info.age, Info.remark, Info.level + '', 0, undefined),
    srcReply: (elements) => bot.sendMsg(contact, elements),
    content: {
      applierId,
      inviterId,
      reason: 'comment' in event.data ? event.data.comment : '',
      flag: event.data.notification_seq + '',
      groupId
    }
  })
}

/** 邀请自身入群 */
function GroupInvite (event: Extract<Event, { event_type: 'group_invitation' }>, bot: MilkyBot) {
  const userId = event.data.initiator_id + ''
  const contact = contactGroup(event.data.group_id + '')
  bot.invitations.stash(event.data.invitation_seq, event.data.group_id)
  createGroupInviteRequest({
    bot,
    time: event.time,
    contact,
    rawEvent: event,
    subEvent: 'groupInvite',
    eventId: `request:${event.time}`,
    sender: senderGroup(userId, 'member'),
    srcReply: (elements) => bot.sendMsg(contact, elements),
    content: {
      inviterId: userId,
      flag: event.data.invitation_seq + '',
    }
  })
}

type HandlerMap = {
  [K in Event['event_type']]: (event: Extract<Event, { event_type: K }>, bot: MilkyBot) => Promise<void> | void
}
const Handlers: HandlerMap = Object.create(null)
Handlers['message_receive'] = createMessage
Handlers['message_recall'] = RecallNotice
Handlers['friend_request'] = FriendRequest
Handlers['group_join_request'] = GroupJoinRequest
Handlers['group_invited_join_request'] = GroupJoinRequest
Handlers['group_invitation'] = GroupInvite
Handlers['friend_nudge'] = FriendPoke
Handlers['friend_file_upload'] = FriendFileUpload
Handlers['group_admin_change'] = GroupAdminChange
Handlers['group_member_increase'] = GroupMemberIncrease
Handlers['group_member_decrease'] = GroupMemberDecrease
Handlers['group_message_reaction'] = GroupMessageReaction
Handlers['group_mute'] = GroupMute
Handlers['group_whole_mute'] = GroupWholeMute
Handlers['group_nudge'] = GroupPoke
Handlers['group_file_upload'] = GroupFileUpload
Handlers['bot_offline'] = BotOffline
Handlers['peer_pin_change'] = PeerPinChange
Handlers['group_essence_message_change'] = GroupEssenceMessageChange
Handlers['group_name_change'] = GroupNameChange

/** milky 事件分发 */
export async function EventDispatch (i: Event, bot: MilkyBot) {
  const handler = Handlers[i.event_type]
  if (!handler) {
    bot.logger('warn', `收到未知事件: ${JSON.stringify(i)}`)
    return false
  }
  return await handler(i as never, bot)
}