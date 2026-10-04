/**
 * 构建 Web 配置面板并复制到插件资源目录
 * 1. pnpm --dir web build (next 静态导出到 web/out)
 * 2. 清空 resources/web 并复制 out 内容
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const webDir = path.join(root, 'web')
const outDir = path.join(webDir, 'out')
const targetDir = path.join(root, 'resources', 'web')

console.log('[web] 安装依赖...')
// web 不在根 workspace 中，需独立安装依赖（本地与 CI 均走此入口）
execSync('pnpm install', { cwd: webDir, stdio: 'inherit' })
console.log('[web] 构建 next.js 配置面板...')
// 清理 next 缓存 避免增量构建的 not-found / trace 偶发报错
fs.rmSync(path.join(webDir, '.next'), { recursive: true, force: true })
execSync('pnpm build', { cwd: webDir, stdio: 'inherit' })

if (!fs.existsSync(outDir)) {
  console.error('[web] 构建产物不存在，请检查 next build 是否成功。')
  process.exit(1)
}

fs.rmSync(targetDir, { recursive: true, force: true })
fs.mkdirSync(targetDir, { recursive: true })
fs.cpSync(outDir, targetDir, { recursive: true })

console.log(`[web] 已复制静态产物到 ${targetDir}`)