import { logger } from 'node-karin'
import type { BaseBot, BotConfig } from '../base'

/** 创建单个 onebot12 Bot 尚未实现 */
export const createOneBot12Bot = (cfg: BotConfig): BaseBot<any> | undefined => {
  if (cfg.protocol !== 'onebot12') return undefined
  logger.warn(`[adapters] onebot12(${cfg.url}) 尚未实现，敬请期待`)
  return undefined
}