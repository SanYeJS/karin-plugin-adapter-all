import { config, onConfigChange } from '@/utils/config'
import { logger } from 'node-karin'
import { createOneBot11Bot } from './onebot11'
import { createOneBot12Bot } from './onebot12'
import { createIcqqBot } from './icqq'
import { createMilkyBot } from './milky'
import { createKookBot } from './kook'
import { createQqBotBot } from './qqbot'
import type { BaseBot, BotConfig, Protocol } from './base'

/** 各协议 bot 工厂 */
const factories: Record<Protocol, (cfg: BotConfig) => BaseBot<any> | undefined> = {
  onebot11: createOneBot11Bot,
  onebot12: createOneBot12Bot,
  icqq: createIcqqBot,
  milky: createMilkyBot,
  kook: createKookBot,
  qqbot: createQqBotBot,
}

/** bot 唯一标识: 协议+实现+通信方式+地址+事件地址+事件接收方式+token+各协议专属参数 */
const keyOf = (cfg: BotConfig) => `${cfg.protocol}|${cfg.impl || ''}|${cfg.communication || ''}|${cfg.url}|${cfg.eventUrl || ''}|${cfg.eventMode || ''}|${cfg.accessToken || ''}|${cfg.uin || ''}|${cfg.password || ''}|${cfg.loginType || ''}|${cfg.platform || ''}|${cfg.ver || ''}|${cfg.sign_api_addr || ''}|${cfg.sliderMode || ''}|${cfg.captchaBase || ''}|${cfg.captchaToken || ''}|${cfg.kookToken || ''}|${cfg.kookApi || ''}|${cfg.kookEventMode || ''}|${cfg.kookWebhookUrl || ''}|${cfg.qqbotAppId || ''}|${cfg.qqbotClientSecret || ''}|${cfg.qqbotApi || ''}|${cfg.qqbotEventMode || ''}|${cfg.qqbotWebhookUrl || ''}`

/** 两份配置是否完全一致 (不一致视为需要重连) */
const sameConfig = (a: BotConfig, b: BotConfig) => JSON.stringify(a) === JSON.stringify(b)

/** 运行中的 bot 注册表 */
const running = new Map<string, { cfg: BotConfig; bot: BaseBot<any> }>()

/** 显示用地址 (icqq 用 icqq:uin, kook/qqbot 用 token/appid 摘要) */
const addrOf = (cfg: BotConfig) => {
  if (cfg.protocol === 'icqq') return `icqq:${cfg.uin || ''}`
  if (cfg.protocol === 'kook') return `kook:${cfg.kookToken || ''}`
  if (cfg.protocol === 'qqbot') return `qqbot:${cfg.qqbotAppId || ''}`
  return cfg.url
}

/** 启动单个 bot 并登记 */
export const boot = async (cfg: BotConfig) => {
  const create = factories[cfg.protocol]
  const bot = create?.(cfg)
  if (!bot) return
  const key = keyOf(cfg)
  running.set(key, { cfg, bot })
  try {
    await bot.start()
    logger.info(`[adapters] ${cfg.protocol}/${cfg.impl || '-'} 已启动: ${addrOf(cfg)}`)
  } catch (e) {
    running.delete(key)
    await bot.stop().catch(() => { })
    logger.error(`[adapters] ${cfg.protocol}/${cfg.impl || '-'} 无法启动: ${(e as Error).stack || (e as Error).message || e} (${addrOf(cfg)})`)
  }
}

/** 停止单个 bot */
export const stop = async (cfg: BotConfig) => {
  const key = keyOf(cfg)
  const entry = running.get(key)
  if (!entry) return
  running.delete(key)
  await entry.bot.stop()
  logger.info(`[adapters] 已断开: ${addrOf(entry.cfg)}`)
}

/** 按 QQ 号查找运行中的 icqq bot (登录短信验证 etc. 供 server HTTP 端点调用) */
export const findIcqqBot = (uin: string | number): BaseBot<any> | undefined => {
  const key = String(uin ?? '').trim()
  if (!key) return undefined
  for (const [, entry] of running) {
    if (entry.cfg.protocol === 'icqq' && String(entry.cfg.uin ?? '') === key) return entry.bot
  }
  return undefined
}

/**
 * 配置热更新: 与当前运行中的 bot 对比
 *  - 被移除/禁用/字段变更 → 停止旧连接 (字段变更后按新配置重建)
 *  - 新增/恢复 → 启动新连接
 * 网页面板保存后由 web.config 调用
 */
export const reload = async () => {
  const next = (config().bots || []).filter(b => b.enable)
  const nextMap = new Map(next.map(c => [keyOf(c), c]))
  /** 停止被移除或配置变更的 bot */
  for (const [key, entry] of [...running]) {
    const target = nextMap.get(key)
    if (!target || !sameConfig(target, entry.cfg)) {
      running.delete(key)
      await entry.bot.stop()
      logger.info(`[adapters] 热更新断开: ${addrOf(entry.cfg)}`)
    }
  }
  /** 启动新增或变更后的 bot */
  for (const cfg of next) {
    if (running.has(keyOf(cfg))) continue
    await boot(cfg)
  }
}

/** 初始化: 启动所有启用的 bot */
const init = async () => {
  for (const cfg of config().bots || []) {
    if (cfg.enable) await boot(cfg)
  }
}
init()

/** 配置文件变更时自动热更新 (网页面板/手动编辑均生效) —— 防重入, 避免连续保存时多个 reload 并发 */
let reloading = false
onConfigChange(() => {
  if (reloading) return
  reloading = true
  reload()
    .catch(e => logger.error(`[adapters] 配置热更新失败: ${e}`))
    .finally(() => { reloading = false })
})