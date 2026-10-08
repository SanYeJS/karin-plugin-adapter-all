import { dir } from '@/dir'
import fs from 'node:fs'
import type { BotConfig } from '@/adapters/base'
import {
  watch,
  filesByExt,
  copyConfigSync,
  requireFileSync,
} from 'node-karin'

export interface Config {
  /** Bot列表 */
  bots?: BotConfig[]
}

/** 网页面板访问前缀 须与 web/next.config.mjs 的 basePath 保持一致 */
export const WEB_PREFIX = '/adapter-all'

/**
 * @description 初始化配置文件
 */
copyConfigSync(dir.defConfigDir, dir.ConfigDir, ['.json'])

/**
 * @description 配置文件兜底初始化:
 * copyConfigSync 在部分发布环境 (npm 包/热更目录) 未能落盘配置时,
 * 直接从插件包模板补齐, 模板也缺失时写入空配置, 避免首次启动 ENOENT
 */
const ensureConfigFile = () => {
  const file = `${dir.ConfigDir}/config.json`
  if (fs.existsSync(file)) return
  fs.mkdirSync(dir.ConfigDir, { recursive: true })
  const template = `${dir.defConfigDir}/config.json`
  if (fs.existsSync(template)) {
    fs.copyFileSync(template, file)
  } else {
    fs.writeFileSync(file, JSON.stringify({ bots: [] }, null, 2))
  }
}
ensureConfigFile()

/**
 * @description 配置文件
 * force 强制重读: requireFileSync 默认缓存 300 秒且命中会续期,
 * 否则热更新/网页面板保存后读到的仍是旧配置
 */
export const config = (): Config => {
  // 每次读取前兜底 (用户可能手动删过 @karinjs 下的配置)
  ensureConfigFile()
  const cfg = requireFileSync(`${dir.ConfigDir}/config.json`, { force: true })
  // 插件包模板容错 (异常发布场景缺失时不阻塞启动)
  const defFile = `${dir.defConfigDir}/config.json`
  const def = fs.existsSync(defFile) ? requireFileSync(defFile) : {}
  return { ...def, ...cfg }
}

/**
 * @description 写入配置文件 (网页面板保存用)
 */
export const saveConfig = (data: Config) => {
  fs.writeFileSync(`${dir.ConfigDir}/config.json`, JSON.stringify(data, null, 2))
}

/** 配置变更监听器 */
type ConfigChangeListener = () => void
const changeListeners = new Set<ConfigChangeListener>()

/**
 * @description 订阅配置文件变更 文件被保存/修改后触发 (热更新等场景使用)
 */
export const onConfigChange = (cb: ConfigChangeListener) => {
  changeListeners.add(cb)
  return () => changeListeners.delete(cb)
}

/**
 * @description 监听配置文件
 */
setTimeout(() => {
  const list = filesByExt(dir.ConfigDir, '.json', 'abs')
  list.forEach(file => watch(file, () => {
    changeListeners.forEach(cb => {
      try { cb() } catch { /* 单个监听器异常不影响其他 */ }
    })
  }))
}, 2000)
