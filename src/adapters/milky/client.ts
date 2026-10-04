import axios, { AxiosInstance } from 'node-karin/axios'
import type {
  CreateGroupFolderOutput,
  GetForwardedMessagesOutput,
  GetFriendRequestsOutput,
  GetGroupAnnouncementsOutput,
  GetGroupEssenceMessagesOutput,
  GetGroupFileDownloadUrlOutput,
  GetGroupFilesOutput,
  GetGroupNotificationsOutput,
  GetHistoryMessagesOutput,
  GetMessageOutput,
  GetPrivateFileDownloadUrlOutput,
  GetResourceTempUrlOutput,
  OutgoingSegment,
  SendGroupMessageOutput,
  SendPrivateMessageOutput,
  UploadGroupFileOutput,
  UploadPrivateFileOutput
} from '@saltify/milky-types'
import type { MessageScene } from './msgId'
import { encodeMsgId, decodeMsgId, encodeVarint, decodeVarint } from './msgId'

type ApiResponse<T = unknown> =
  | { status: 'ok'; retcode: 0; data: T }
  | { status: 'failed'; retcode: number; message: string }

/**
 * milky 协议端 HTTP 客户端。
 * 所有请求 POST `{url}/api/<action>`，携带 `Authorization: Bearer <token>`。
 * 响应 status 为 failed 时抛出 message。
 */
export class Client {
  #axios: AxiosInstance

  constructor (url: string, token?: string) {
    this.#axios = axios.create({
      baseURL: new URL('api', `${url.endsWith('/') ? url : `${url}/`}`).toString(),
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      }
    })
    this.#axios.interceptors.request.use(config => {
      if (token) {
        config.headers.Authorization = `Bearer ${token}`
      }
      return config
    })
  }

  async request<T = any> (path: string, data?: any): Promise<T> {
    const res = await this.#axios.post<ApiResponse<T>>(path, data ?? {})
    if (res.data.status === 'failed') {
      throw new Error(res.data.message)
    }
    return res.data.data
  }

  /* === system === */
  getLoginInfo = () => this.request('/get_login_info')
  getImplInfo = () => this.request('/get_impl_info')
  getUserProfile = (userId: number) => this.request('/get_user_profile', { user_id: +userId })
  getFriendList = (noCache?: boolean) => this.request('/get_friend_list', { no_cache: noCache })
  getFriendInfo = (userId: number, noCache?: boolean) => this.request('/get_friend_info', { user_id: +userId, no_cache: noCache })
  getGroupList = (noCache?: boolean) => this.request('/get_group_list', { no_cache: noCache })
  getGroupInfo = (groupId: number, noCache?: boolean) => this.request('/get_group_info', { group_id: +groupId, no_cache: noCache })
  getGroupMemberList = (groupId: number, noCache?: boolean) => this.request('/get_group_member_list', { group_id: +groupId, no_cache: noCache })
  getGroupMemberInfo = (groupId: number, userId: number, noCache?: boolean) => this.request('/get_group_member_info', { group_id: +groupId, user_id: +userId, no_cache: noCache })
  getPeerPins = () => this.request('/get_peer_pins')
  setPeerPin = (scene: 'group' | 'friend' | 'temp', peerId: number, isPinned?: boolean) => this.request('/set_peer_pin', { message_scene: scene, peer_id: +peerId, is_pinned: isPinned })
  setAvatar = (uri: string) => this.request('/set_avatar', { uri })
  setNickName = (name: string) => this.request('/set_nickname', { nickname: name })
  setBio = (bio: string) => this.request('/set_bio', { bio })
  getCustomFaceUrlList = () => this.request('/get_custom_face_url_list')
  getCookies = (domain: string) => this.request('/get_cookies', { domain })
  getCSRFToken = () => this.request('/get_csrf_token')

  /* === friend === */
  sendFriendNudge = (userId: number, isSelf?: boolean) => this.request('/send_friend_nudge', { user_id: +userId, is_self: isSelf })
  sendProfileLike = (userId: number, count?: number) => this.request('/send_profile_like', { user_id: +userId, count })
  deleteFriend = (userId: number) => this.request('/delete_friend', { user_id: +userId })
  getFriendRequests = (limit?: number, isFiltered?: boolean) => this.request<GetFriendRequestsOutput>('/get_friend_requests', { limit, is_filtered: isFiltered })
  acceptFriendRequest = (initiatorUid: string, isFiltered?: boolean) => this.request('/accept_friend_request', { initiator_uid: initiatorUid, is_filtered: isFiltered })
  rejectFriendRequest = (initiatorUid: string, isFiltered?: boolean, reason?: string) => this.request('/reject_friend_request', { initiator_uid: initiatorUid, is_filtered: isFiltered, reason })

  /* === group === */
  setGroupName = (groupId: number, name: string) => this.request('/set_group_name', { group_id: +groupId, new_group_name: name })
  setGroupAvatar = (groupId: number, uri: string) => this.request('/set_group_avatar', { group_id: +groupId, image_uri: uri })
  setGroupMemberCard = (groupId: number, userId: number, card: string) => this.request('/set_group_member_card', { group_id: +groupId, user_id: +userId, card })
  setGroupMemberSpecialTitle = (groupId: number, userId: number, title: string) => this.request('/set_group_member_special_title', { group_id: +groupId, user_id: +userId, special_title: title })
  setGroupMemberAdmin = (groupId: number, userId: number, isSet?: boolean) => this.request('/set_group_member_admin', { group_id: +groupId, user_id: +userId, is_set: isSet })
  setGroupMemberMute = (groupId: number, userId: number, duration?: number) => this.request('/set_group_member_mute', { group_id: +groupId, user_id: +userId, duration })
  setGroupWholeMute = (groupId: number, isMute?: boolean) => this.request('/set_group_whole_mute', { group_id: +groupId, is_mute: isMute })
  kickGroupMember = (groupId: number, userId: number, rejectRequest?: boolean) => this.request('/kick_group_member', { group_id: +groupId, user_id: +userId, reject_add_request: rejectRequest })
  getGroupAnnouncements = (groupId: number) => this.request<GetGroupAnnouncementsOutput>('/get_group_announcements', { group_id: +groupId })
  sendGroupAnnouncement = (groupId: number, content: string, uri?: string) => this.request('/send_group_announcement', { group_id: +groupId, content, image_uri: uri })
  deleteGroupAnnouncement = (groupId: number, id: string) => this.request('/delete_group_announcement', { group_id: +groupId, announcement_id: String(id) })
  getGroupEssenceMessages = (groupId: number, pageIndex: number, pageSize: number) => this.request<GetGroupEssenceMessagesOutput>('/get_group_essence_messages', { group_id: +groupId, page_index: +pageIndex, page_size: +pageSize })
  setGroupEssenceMessage = (groupId: number, messageSeq: number, isSet?: boolean) => this.request('/set_group_essence_message', { group_id: +groupId, message_seq: messageSeq, is_set: isSet })
  quitGroup = (groupId: number) => this.request('/quit_group', { group_id: +groupId })
  sendGroupMessageReaction = (groupId: number, messageSeq: number, reaction: string, reactionType: 'face' | 'emoji', isAdd?: boolean) => this.request('/send_group_message_reaction', { group_id: +groupId, message_seq: messageSeq, reaction, reaction_type: reactionType, is_add: isAdd })
  sendGroupNudge = (groupId: number, userId: number) => this.request('/send_group_nudge', { group_id: +groupId, user_id: +userId })
  getGroupNotifications = (start?: number, isFiltered?: boolean, limit?: number) => this.request<GetGroupNotificationsOutput>('/get_group_notifications', { start_notification_seq: start, is_filtered: isFiltered, limit })
  acceptGroupRequest = (noticeId: number, noticeType: 'join_request' | 'invited_join_request', groupId: number, isFiltered?: boolean) => this.request('/accept_group_request', { notification_seq: noticeId, notification_type: noticeType, group_id: +groupId, is_filtered: isFiltered })
  rejectGroupRequest = (noticeId: number, noticeType: 'join_request' | 'invited_join_request', groupId: number, isFiltered?: boolean, reason?: string) => this.request('/reject_group_request', { notification_seq: noticeId, notification_type: noticeType, group_id: +groupId, is_filtered: isFiltered, reason })
  acceptGroupInvitation = (groupId: number, invitationSeq: number) => this.request('/accept_group_invitation', { group_id: +groupId, invitation_seq: invitationSeq })
  rejectGroupInvitation = (groupId: number, invitationSeq: number) => this.request('/reject_group_invitation', { group_id: +groupId, invitation_seq: invitationSeq })

  /* === message === */
  sendPrivateMessage = (userId: number, message: OutgoingSegment[]) => this.request<SendPrivateMessageOutput>('/send_private_message', { user_id: +userId, message })
  sendGroupMessage = (groupId: number, message: OutgoingSegment[]) => this.request<SendGroupMessageOutput>('/send_group_message', { group_id: +groupId, message })
  recallPrivateMessage = (userId: number, messageSeq: number) => this.request('/recall_private_message', { user_id: +userId, message_seq: +messageSeq })
  recallGroupMessage = (groupId: number, messageSeq: number) => this.request('/recall_group_message', { group_id: +groupId, message_seq: +messageSeq })
  getMessage = (scene: MessageScene, peerId: number, messageSeq: number) => this.request<GetMessageOutput>('/get_message', { message_scene: scene, peer_id: +peerId, message_seq: +messageSeq })
  getHistoryMessage = (scene: MessageScene, peerId: number, start?: number, limit?: number) => this.request<GetHistoryMessagesOutput>('/get_history_messages', { message_scene: scene, peer_id: +peerId, start_message_seq: start, limit })
  getResourceTempUrl = (resourceId: string) => this.request<GetResourceTempUrlOutput>('/get_resource_temp_url', { resource_id: resourceId })
  getForwardedMessage = (forwardId: string) => this.request<GetForwardedMessagesOutput>('/get_forwarded_messages', { forward_id: forwardId })
  markMessageAsRead = (scene: MessageScene, peerId: number, messageSeq: number) => this.request('/mark_message_as_read', { message_scene: scene, peer_id: +peerId, message_seq: +messageSeq })

  /* === file === */
  uploadPrivateFile = (userId: number, fileUri: string, fileName: string) => this.request<UploadPrivateFileOutput>('/upload_private_file', { user_id: +userId, file_uri: fileUri, file_name: fileName })
  uploadGroupFile = (groupId: number, folderId: string, fileUri: string, fileName: string) => this.request<UploadGroupFileOutput>('/upload_group_file', { group_id: +groupId, parent_folder_id: folderId, file_uri: fileUri, file_name: fileName })
  getPrivateFileDownloadUrl = (userId: number, fileId: string, fileHash: string) => this.request<GetPrivateFileDownloadUrlOutput>('/get_private_file_download_url', { user_id: +userId, file_id: fileId, file_hash: fileHash })
  getGroupFileDownloadUrl = (groupId: number, fileId: string) => this.request<GetGroupFileDownloadUrlOutput>('/get_group_file_download_url', { group_id: +groupId, file_id: fileId })
  getGroupFiles = (groupId: number, folderId?: string) => this.request<GetGroupFilesOutput>('/get_group_files', { group_id: +groupId, parent_folder_id: folderId })
  moveGroupFile = (groupId: number, fileId: string, folderId: string, targetId: string) => this.request('/move_group_file', { group_id: +groupId, file_id: fileId, parent_folder_id: folderId, target_folder_id: targetId })
  renameGroupFile = (groupId: number, fileId: string, folderId: string, newName: string) => this.request('/rename_group_file', { group_id: +groupId, file_id: fileId, parent_folder_id: folderId, new_file_name: newName })
  deleteGroupFile = (groupId: number, fileId: string) => this.request('/delete_group_file', { group_id: +groupId, file_id: fileId })
  createGroupFolder = (groupId: number, folderName: string) => this.request<CreateGroupFolderOutput>('/create_group_folder', { group_id: +groupId, folder_name: folderName })
  renameGroupFolder = (groupId: number, folderId: string, newName: string) => this.request('/rename_group_folder', { group_id: +groupId, folder_id: folderId, new_folder_name: newName })
  deleteGroupFolder = (groupId: number, folderId: string) => this.request('/delete_group_folder', { group_id: +groupId, folder_id: folderId })

  /* === msgId 工具 === */
  encodeMsgId = encodeMsgId
  decodeMsgId = decodeMsgId
  encodeVarint = encodeVarint
  decodeVarint = decodeVarint
}