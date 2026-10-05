import { config, onConfigChange } from '@/utils/config'
import { logger } from 'node-karin'
import { createOneBot11Bot } from './onebot11'
import { createOneBot12Bot } from './onebot12'
import { createMilkyBot } from './milky'
import { createKookBot } from './kook'
import { createQqBotBot } from './qqbot'
import { createDouyinBot } from './douyin'
import { createWxocBot } from './wxoc'
import type { BaseBot, BotConfig, Protocol } from './base'

/** 各协议 bot 工厂 (icqq 为可选适配器, 按需动态加载) */
const factories: Partial<Record<Protocol, (cfg: BotConfig) => BaseBot<any> | undefined>> = {
  onebot11: createOneBot11Bot,
  onebot12: createOneBot12Bot,
  milky: createMilkyBot,
  kook: createKookBot,
  qqbot: createQqBotBot,
  douyin: createDouyinBot,
  wxoc: createWxocBot,
}

/** GitHub Packages 认证 + 安装 @icqqjs/icqq (日志提示与 server 保存拦截共用) */
export const ICQQ_INSTALL_CMD = 'npm config set @icqqjs:registry=https://npm.pkg.github.com && npm login --scope=@icqqjs --auth-type=legacy --registry=https://npm.pkg.github.com && pnpm add @icqqjs/icqq@1.12.3 -w'

/** 动态加载 icqq 适配器; 未安装 / 装错包 / 版本过低时给出可操作提示并跳过 */
const loadIcqq = async (cfg: BotConfig): Promise<BaseBot<any> | undefined> => {
  const uin = cfg.uin || ''
  try {
    const { createIcqqBot } = await import('./icqq')
    return createIcqqBot(cfg)
  } catch (e) {
    const msg = (e as Error)?.message || String(e)
    logger.warn(`[adapters] icqq 适配器不可用 (${uin}): ${/Cannot find|MODULE_NOT_FOUND/.test(msg)
      ? `未安装 @icqqjs/icqq (勿装 npm 老包 icqq@0.6.10), 执行: ${ICQQ_INSTALL_CMD}`
      : `请升级 @icqqjs/icqq 至 1.12.x: pnpm add @icqqjs/icqq@1.12.3 -w (${msg})`}`)
    return undefined
  }
}

/** bot 唯一标识: 协议+实现+通信方式+地址+事件地址+事件接收方式+token+各协议专属参数 */
const keyOf = (cfg: BotConfig) => `${cfg.protocol}|${cfg.impl || ''}|${cfg.communication || ''}|${cfg.url}|${cfg.eventUrl || ''}|${cfg.eventMode || ''}|${cfg.accessToken || ''}|${cfg.uin || ''}|${cfg.password || ''}|${cfg.loginType || ''}|${cfg.platform || ''}|${cfg.ver || ''}|${cfg.sign_api_addr || ''}|${cfg.sliderMode || ''}|${cfg.kookToken || ''}|${cfg.kookEventMode || ''}|${cfg.kookWebhookUrl || ''}|${cfg.qqbotAppId || ''}|${cfg.qqbotClientSecret || ''}|${cfg.qqbotEventMode || ''}|${cfg.qqbotWebhookUrl || ''}|${cfg.douyinUid || ''}|${cfg.douyinName || ''}|${cfg.wxocToken || ''}|${cfg.wxocAccountId || ''}|${cfg.wxocUserId || ''}|${cfg.wxocNickname || ''}|${cfg.wxocBaseUrl || ''}`

/** 两份配置是否完全一致 (不一致视为需要重连) */
const sameConfig = (a: BotConfig, b: BotConfig) => JSON.stringify(a) === JSON.stringify(b)

/** 运行中的 bot 注册表 */
const running = new Map<string, { cfg: BotConfig; bot: BaseBot<any> }>()

/** 显示用地址 (icqq 用 icqq:uin, kook/qqbot 用 token/appid 摘要, douyin/wxoc 用昵称或 uid) */
const addrOf = (cfg: BotConfig) => {
  if (cfg.protocol === 'icqq') return `icqq:${cfg.uin || ''}`
  if (cfg.protocol === 'kook') return `kook:${cfg.kookToken || ''}`
  if (cfg.protocol === 'qqbot') return `qqbot:${cfg.qqbotAppId || ''}`
  if (cfg.protocol === 'douyin') return `douyin:${cfg.douyinName || cfg.douyinUid || ''}`
  if (cfg.protocol === 'wxoc') return `wxoc:${cfg.wxocNickname || cfg.wxocAccountId || ''}`
  return cfg.url
}

/** 启动单个 bot 并登记 */
export const boot = async (cfg: BotConfig) => {
  const bot = cfg.protocol === 'icqq'
    ? await loadIcqq(cfg)
    : factories[cfg.protocol]?.(cfg)
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

/** qqbot 是否已建立连接 (扫码绑定页面判断「登录成功」用) */
export const isQqbotOnline = (appId: string | number): boolean => {
  const target = String(appId ?? '').trim()
  if (!target) return false
  for (const [, entry] of running) {
    if (entry.cfg.protocol !== 'qqbot') continue
    if (String(entry.cfg.qqbotAppId ?? '').trim() !== target) continue
    const raw: any = (entry.bot as any).raw
    return Boolean(raw?.isConnected || raw?.mode === 'webhook')
  }
  return false
}

/** douyin 是否已建立连接 (扫码绑定页面判断「登录成功」用) */
export const isDouyinOnline = (uid: string | number): boolean => {
  const target = String(uid ?? '').trim()
  if (!target) return false
  for (const [, entry] of running) {
    if (entry.cfg.protocol !== 'douyin') continue
    if (String(entry.cfg.douyinUid ?? '').trim() !== target) continue
    return entry.bot.adapter.index !== -1
  }
  return false
}

/** wxoc 是否已建立连接 (扫码绑定页面判断「登录成功」用) */
export const isWxocOnline = (accountId: string | number): boolean => {
  const target = String(accountId ?? '').trim()
  if (!target) return false
  for (const [, entry] of running) {
    if (entry.cfg.protocol !== 'wxoc') continue
    if (String(entry.cfg.wxocAccountId ?? '').trim() !== target) continue
    return entry.bot.adapter.index !== -1
  }
  return false
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