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
 * @description 配置文件
 * force 强制重读: requireFileSync 默认缓存 300 秒且命中会续期,
 * 否则热更新/网页面板保存后读到的仍是旧配置
 */
export const config = (): Config => {
  const cfg = requireFileSync(`${dir.ConfigDir}/config.json`, { force: true })
  const def = requireFileSync(`${dir.defConfigDir}/config.json`)
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
