import { db } from 'node-karin'
import type { MessageResponse } from 'node-karin'

/** 每个会话保留的历史消息条数上限 */
const HISTORY_MAX = 200

const dbKey = (botId: string) => `wxoc:history:${botId}`

/** 账号历史结构 { [会话 peer]: MessageResponse[] } 旧→新 */
type HistoryData = Record<string, Array<MessageResponse>>

/** 读取账号历史 */
const read = async (botId: string): Promise<HistoryData> => (await db.get<HistoryData>(dbKey(botId))) || {}

/**
 * 历史消息存储 (Karin kv 数据库) 按 botId 隔离
 */
export const history = {
  /** 保存历史消息 每个会话超出上限裁剪最旧的 */
  async save (botId: string, raw: MessageResponse): Promise<void> {
    if (!botId || !raw?.messageId) return
    const peer = raw.contact?.peer
    if (!peer) return

    const data = await read(botId)
    const list = data[peer] || []
    const index = list.findIndex(item => item.messageId === raw.messageId)
    if (index !== -1) list[index] = raw
    else list.push(raw)
    if (list.length > HISTORY_MAX) list.splice(0, list.length - HISTORY_MAX)
    data[peer] = list

    await db.set(dbKey(botId), data)
  },

  /** 获取单条历史消息 */
  async get (botId: string, messageId: string): Promise<MessageResponse | null> {
    if (!botId || !messageId) return null
    const data = await read(botId)
    for (const list of Object.values(data)) {
      const raw = list.find(item => item.messageId === messageId)
      if (raw) return raw
    }
    return null
  },

  /** 获取会话历史消息 startMsgId 为空取最新 count 条 否则取该消息及其之前的 count 条 按时间新→旧排序 */
  async list (botId: string, userId: string, startMsgId: string, count: number): Promise<Array<MessageResponse>> {
    if (!botId || !userId) return []
    const list = (await read(botId))[userId] || []
    if (!list.length) return []

    let selected: Array<MessageResponse>
    if (startMsgId) {
      const index = list.findIndex(item => item.messageId === startMsgId)
      if (index === -1) return []
      selected = list.slice(Math.max(0, index - count + 1), index + 1)
    } else {
      selected = list.slice(-count)
    }
    return selected.reverse()
  },
}
