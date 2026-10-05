/**
 * 独立启动 web dev server (与新开窗口分离, 不与 framework 捆绑)
 * 若 web 已在运行 (端口已被监听) 则直接退出, 避免重复启动。
 */
import { createConnection } from 'node:net'
import { exec } from 'node:child_process'
import { join } from 'node:path'

const webDir = join(process.cwd(), 'web')
const port = 4111

/** 检查 web dev server 端口是否已在监听 */
const isListening = () => new Promise((resolve) => {
  const sock = createConnection({ port, host: '127.0.0.1' })
  sock.once('connect', () => { sock.destroy(); resolve(true) })
  sock.once('error', () => resolve(false))
})

const running = await isListening()
if (running) {
  console.log(`[dev-web] web dev server 已在运行 (http://localhost:${port}), 无需重复启动`)
} else {
  // 用 PowerShell 而非 cmd: PSReadLine 支持编辑续行/Ctrl+C 干净退出,
  // 避免 cmd 粘贴不完整命令后卡死在 "More?" 续行提示
  exec(`start "web-dev" powershell -NoExit -Command "cd '${webDir}'; pnpm dev"`, (err, _stdout, stderr) => {
    if (err) console.error('[dev-web] 启动 web 新窗口失败:', stderr || err.message)
  })
}