import { logger, redis } from 'node-karin'

const hashKey = (botId: string) => `karin:wxoc:${botId}`

/**
 * 账号状态存储 (syncBuf / contextToken / 联系人) 按 botId 隔离
 */
export const state = {
  /** 获取长轮询游标 */
  async getSyncBuf (botId: string): Promise<string> {
    if (!botId) return ''
    try {
      return (await redis.hGet(hashKey(botId), 'syncBuf')) || ''
    } catch (error) {
      logger.error(`[wxoc] 读取 syncBuf 失败: ${(error as Error).message}`)
      return ''
    }
  },

  /** 保存长轮询游标 */
  async setSyncBuf (botId: string, syncBuf: string): Promise<void> {
    if (!botId || !syncBuf) return
    await redis.hSet(hashKey(botId), 'syncBuf', syncBuf)
  },

  /** 获取会话上下文 token */
  async getContext (botId: string, userId: string): Promise<string> {
    if (!botId || !userId) return ''
    try {
      return (await redis.hGet(hashKey(botId), `context:${userId}`)) || ''
    } catch (error) {
      logger.error(`[wxoc] 读取 contextToken 失败: ${(error as Error).message}`)
      return ''
    }
  },

  /** 保存会话上下文 token */
  async setContext (botId: string, userId: string, contextToken: string): Promise<void> {
    if (!botId || !userId || !contextToken) return
    await redis.hSet(hashKey(botId), `context:${userId}`, contextToken)
  },

  /** 删除会话上下文 token */
  async clearContext (botId: string, userId: string): Promise<void> {
    if (!botId || !userId) return
    await redis.hDel(hashKey(botId), `context:${userId}`)
  },

  /** 记录联系人昵称 */
  async setContact (botId: string, userId: string, name: string): Promise<void> {
    if (!botId || !userId || !name) return
    await redis.hSet(hashKey(botId), `contact:${userId}`, JSON.stringify({ name, time: Date.now() }))
  },

  /** 获取单个联系人 */
  async getContact (botId: string, userId: string): Promise<{ name: string; time: number } | null> {
    if (!botId || !userId) return null
    try {
      const raw = await redis.hGet(hashKey(botId), `contact:${userId}`)
      if (!raw) return null
      const data = JSON.parse(raw)
      return { name: data.name || '', time: data.time || 0 }
    } catch {
      return null
    }
  },

  /** 获取全部联系人 */
  async getContacts (botId: string): Promise<Array<{ userId: string; name: string; time: number }>> {
    if (!botId) return []
    try {
      const all = await redis.hGetAll(hashKey(botId))
      const contacts: Array<{ userId: string; name: string; time: number }> = []
      for (const [key, raw] of Object.entries(all || {})) {
        if (!key.startsWith('contact:')) continue
        try {
          const data = JSON.parse(raw)
          contacts.push({ userId: key.slice(8), name: data.name || '', time: data.time || 0 })
        } catch { /* 跳过损坏数据 */ }
      }
      return contacts
    } catch (error) {
      logger.error(`[wxoc] 读取联系人失败: ${(error as Error).message}`)
      return []
    }
  },
}
