import { logger } from 'node-karin'
import { SnowLumaBot } from './snowluma'
import { NapCatBot } from './napcat'
import { LagrangeBot } from './lagrange'
import { OneBot11StdBot } from './std'
import type { BaseBot, BotConfig, OneBot11Impl } from '../base'

/** 已实现的OneBot11实现 lagrangeV2等尚未接入 */
const supported: Partial<Record<OneBot11Impl, new (cfg: BotConfig) => BaseBot<any>>> = {
  snowluma: SnowLumaBot,
  napcat: NapCatBot,
  lagrange: LagrangeBot,
  /** 标准 OneBot11: 不依赖特定实现扩展, 任何符合规范的协议端均可接入 */
  std: OneBot11StdBot,
}

/** 创建单个 OneBot11 Bot (仅构造, 由管理器 start/stop) */
export const createOneBot11Bot = (cfg: BotConfig): BaseBot<any> | undefined => {
  if (cfg.protocol !== 'onebot11') return undefined
  const impl: OneBot11Impl = cfg.impl || 'snowluma'
  const Ctor = supported[impl]
  if (!Ctor) {
    logger.warn(`[adapters] onebot11 实现 "${impl}" 尚未实现，当前可用: ${Object.keys(supported).join(', ')}`)
    return undefined
  }
  return new Ctor(cfg)
}