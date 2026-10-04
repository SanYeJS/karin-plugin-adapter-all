import path from 'node:path'
import express from 'node-karin/express'
import { app, createServerErrorResponse, createSuccessResponse, logger } from 'node-karin'
import { dir } from '@/dir'
import { WEB_PREFIX, config, saveConfig } from '@/utils/config'
import { subscribeLoginSSE, emitLoginEvent } from '@/utils/login-events'
import { startQr, pollQr, cancelQr } from '@/utils/qqbot-qr'
import { findIcqqBot } from '@/adapters'
import type { BotConfig, OneBot11Communication, OneBot11Impl, Protocol } from '@/adapters/base'

/** next 静态导出产物目录 */
const webDir = path.join(dir.pluginDir, 'resources', 'web')

/** 支持的协议端 */
const protocols: Protocol[] = ['onebot11', 'onebot12', 'icqq', 'milky', 'kook', 'qqbot']
/** onebot11 支持的具体实现 */
const impls: OneBot11Impl[] = ['snowluma', 'napcat', 'lagrange', 'std']

/**
 * @description 归一化单个 bot 配置 过滤非法协议与空地址
 *
 * 前端保存时已做过一轮过滤, 这里二次校验防止绕过面板直接调用 API
 */
const normalizeBot = (item: Record<string, any>): BotConfig | undefined => {
  const protocol = (item.protocol || 'onebot11') as Protocol
  if (!protocols.includes(protocol)) return undefined
  const url = String(item.url || '').trim()
  // icqq / kook / qqbot 为协议直连(token 或 appid 鉴权) 允许无 url
  if (!['icqq', 'kook', 'qqbot'].includes(protocol) && !url) return undefined
  const heartbeatInterval = Number(item.heartbeatInterval)
  const requestTimeout = Number(item.requestTimeout)
  const bot: BotConfig = { enable: item.enable !== false, protocol, url, reconnect: item.reconnect !== false }
  if (protocol === 'onebot11') {
    const impl = (item.impl || 'snowluma') as OneBot11Impl
    if (impls.includes(impl)) bot.impl = impl
    // 通信方式 (默认正向 WS) 与 HTTP/SSE 模式的事件地址
    const communication = (item.communication || 'ws') as OneBot11Communication
    if (['ws', 'ws-reverse', 'http', 'sse'].includes(communication) && communication !== 'ws') bot.communication = communication
    const eventUrl = String(item.eventUrl || '').trim()
    if (eventUrl) bot.eventUrl = eventUrl
  }
  if (protocol === 'milky') {
    // 事件接收方式 (默认 ws) 与 WebHook 模式的本端监听地址
    const eventMode = (item.eventMode || 'ws') as 'ws' | 'sse' | 'webhook'
    if (['ws', 'sse', 'webhook'].includes(eventMode) && eventMode !== 'ws') bot.eventMode = eventMode
    const eventUrl = String(item.eventUrl || '').trim()
    if (eventUrl) bot.eventUrl = eventUrl
  }
  if (protocol === 'icqq') {
    // icqq 专属参数 (协议直连 无 url)
    const uin = item.uin ?? item.account
    if (uin !== undefined && uin !== null && String(uin).trim() !== '') bot.uin = String(uin).trim()
    const password = String(item.password || '')
    if (password) bot.password = password
    const loginType = String(item.loginType || 'fast')
    if (['fast', 'password', 'qrcode'].includes(loginType) && loginType !== 'fast') bot.loginType = loginType as BotConfig['loginType']
    const platform = Number(item.platform)
    if (Number.isFinite(platform) && platform > 0) bot.platform = platform
    const ver = String(item.ver || '').trim()
    if (ver) bot.ver = ver
    const signApiAddr = String(item.sign_api_addr || '').trim()
    if (signApiAddr) bot.sign_api_addr = signApiAddr
    const sliderMode = String(item.sliderMode || 'auto')
    if (['auto', 'gt', 'txhelper', 'pages', 'manual'].includes(sliderMode) && sliderMode !== 'auto') bot.sliderMode = sliderMode as BotConfig['sliderMode']
    const captchaBase = String(item.captchaBase || '').trim()
    if (captchaBase) bot.captchaBase = captchaBase
    const captchaToken = String(item.captchaToken || '').trim()
    if (captchaToken) bot.captchaToken = captchaToken
  }
  if (protocol === 'kook') {
    // kook 专属参数 (官方 API 直连, token 鉴权, 无 url)
    const kookToken = String(item.kookToken || '').trim()
    if (kookToken) bot.kookToken = kookToken
    const kookApi = String(item.kookApi || '').trim()
    if (kookApi) bot.kookApi = kookApi
    const kookEventMode = String(item.kookEventMode || 'ws')
    if (['ws', 'webhook'].includes(kookEventMode) && kookEventMode !== 'ws') bot.kookEventMode = kookEventMode as BotConfig['kookEventMode']
    const kookWebhookUrl = String(item.kookWebhookUrl || '').trim()
    if (kookWebhookUrl) bot.kookWebhookUrl = kookWebhookUrl
  }
  if (protocol === 'qqbot') {
    // qqbot 专属参数 (开放平台 appid+token 鉴权, 无 url)
    const qqbotAppId = String(item.qqbotAppId || '').trim()
    if (qqbotAppId) bot.qqbotAppId = qqbotAppId
    const qqbotClientSecret = String(item.qqbotClientSecret || '').trim()
    if (qqbotClientSecret) bot.qqbotClientSecret = qqbotClientSecret
    const qqbotApi = String(item.qqbotApi || '').trim()
    if (qqbotApi) bot.qqbotApi = qqbotApi
    const qqbotEventMode = String(item.qqbotEventMode || 'ws')
    if (['ws', 'webhook'].includes(qqbotEventMode) && qqbotEventMode !== 'ws') bot.qqbotEventMode = qqbotEventMode as BotConfig['qqbotEventMode']
    const qqbotWebhookUrl = String(item.qqbotWebhookUrl || '').trim()
    if (qqbotWebhookUrl) bot.qqbotWebhookUrl = qqbotWebhookUrl
  }
  if (item.accessToken) bot.accessToken = String(item.accessToken).trim()
  if (Number.isFinite(heartbeatInterval) && heartbeatInterval > 0) bot.heartbeatInterval = heartbeatInterval
  if (Number.isFinite(requestTimeout) && requestTimeout > 0) bot.requestTimeout = requestTimeout
  // 消息正则替换 (kook/qqbot): 过滤非法正则与空项
  if (item.msgReplaceEnable === false) bot.msgReplaceEnable = false
  const msgReplace = (Array.isArray(item.msgReplace) ? item.msgReplace : [])
    .filter((r: any): r is any => Boolean(r && typeof r === 'object' && String(r.match || '').trim()))
    .map((r: any) => ({ match: String(r.match).trim(), to: String(r.to ?? '') }))
  if (msgReplace.length) bot.msgReplace = msgReplace
  return bot
}

/** 配置读写路由 */
const apiRouter = express.Router()

// 简单 CORS: next dev 跨源联调时允许访问 (生产同源无影响)
apiRouter.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// 解析 JSON body (Karin 主 app 未挂载全局 json 中间件)
apiRouter.use(express.json())

/** 读取当前配置 */
apiRouter.get('/', (_req, res) => {
  createSuccessResponse(res, config())
})

/** 保存配置 写入后由 config 监听自动热更新 */
apiRouter.post('/', (req, res) => {
  try {
    const body = (req.body ?? {}) as { bots?: unknown }
    if (!Array.isArray(body.bots)) throw new Error('bots 字段必须是数组')
    const bots = body.bots
      .filter((b): b is Record<string, any> => Boolean(b && typeof b === 'object'))
      .map((b) => normalizeBot(b))
      .filter((b): b is BotConfig => Boolean(b))
    saveConfig({ bots })
    createSuccessResponse(res, null, `保存成功，已生效 ${bots.length} 个连接`)
  } catch (err) {
    createServerErrorResponse(res, `保存失败: ${err instanceof Error ? err.message : String(err)}`)
  }
})

/**
 * 代理签名服务的 /ver 接口: WebUI 的「协议版本」下拉通过此端点获取可用版本列表
 * 经本端转发避免浏览器 CORS / 混合内容限制, 并加超时防止签名服务挂起拖死面板
 */
apiRouter.get('/sign/ver', async (req, res) => {
  let addr = ''
  try {
    addr = String(req.query.addr ?? '').trim().replace(/\/+$/, '')
    if (!addr) throw new Error('缺少签名服务地址 addr')
    const uin = String(req.query.uin ?? '').trim()
    // 兼容直接填 `/ver` 结尾的完整地址: 已带则原样请求, 否则自动追加
    const url = /\/ver$/i.test(addr) ? addr : `${addr}/ver`
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 8000)
    try {
      const resp = await fetch(`${url}${uin ? `?uin=${encodeURIComponent(uin)}` : ''}`, {
        signal: ctrl.signal,
        headers: { Accept: 'application/json' },
      })
      const text = await resp.text()
      let json: any
      try { json = JSON.parse(text) } catch { throw new Error(`签名服务响应非 JSON: ${text.slice(0, 120)}`) }
      if (json?.code !== 0) throw new Error(String(json?.msg || json?.message || '签名服务返回错误'))
      // 不同签名服务实现结构不一: 标准 qsign 顶层 ver; 部分代理站在 data.ver / data.support
      const raw = [json?.ver, json?.data?.ver, json?.data?.support]
        .find((v) => Array.isArray(v) && (v as unknown[]).length)
      const ver = Array.isArray(raw) ? raw.map(String) : []
      if (!ver.length && json?.data?.protocol?.ver) ver.push(String(json.data.protocol.ver))
      if (!ver.length) throw new Error('签名服务未返回可用的 ver 列表')
      createSuccessResponse(res, { ver, protocol: json?.protocol ?? json?.data?.protocol ?? null })
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    logger.error(`[web] 获取签名服务版本失败 (addr=${addr}): ${detail}`)
    createServerErrorResponse(res, `获取版本失败: ${detail}`)
  }
})

// 先注册 API 再挂静态资源, 避免静态兜底抢占
app.use(`${WEB_PREFIX}/api/config`, apiRouter)

/** 登录验证事件流 (SSE): icqq 登录验证流程的状态推送, 供 WebUI 展示验证链接与进度 */
const loginRouter = express.Router()
// 简单 CORS: next dev 跨源联调时允许访问
loginRouter.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})
loginRouter.use(express.json())
loginRouter.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()
  subscribeLoginSSE(res)
})

/**
 * 登录短信验证 / 手动续登 (icqq 设备锁):
 *  - action=send   调用客户端 sendSmsCode 发送验证码短信 (仅老协议)
 *  - action=submit 调用客户端 submitSmsCode 提交验证码 (body.code, 仅老协议)
 *  - action=retry  设备锁网页验证完成后调用客户端 login() 重新登录 (NT/老协议通用, 必选路径)
 * 完成后回推登录事件, WebUI 时间线/徽章自动更新
 */
loginRouter.post('/sms', async (req, res) => {
  try {
    const { uin, action, code } = (req.body ?? {}) as { uin?: string | number; action?: 'send' | 'submit' | 'retry'; code?: string }
    const key = String(uin ?? '').trim()
    if (!key) throw new Error('缺少 uin')
    const bot = findIcqqBot(key)
    if (!bot) throw new Error(`未找到 QQ ${key} 的 icqq 连接, 请确认该账号已启用`)
    const sendApi = (bot as any).sendApi
    if (action === 'send') {
      // NT 协议 (useNTLogin) 设备锁无短信通道, sendSmsCode/submitSmsCode 仅老协议可用
      if ((bot as any)?.super?.useNTLogin) {
        throw new Error('NT 协议设备锁不支持短信验证, 请打开验证链接完成')
      }
      if (typeof sendApi !== 'function') throw new Error('该连接不支持 sendSmsCode')
      await sendApi.call(bot, 'sendSmsCode')
      emitLoginEvent(key, { type: 'progress', title: '验证码已发送', message: '请查收短信后输入验证码提交' })
      createSuccessResponse(res, null, '验证码已发送, 请注意查收短信')
    } else if (action === 'submit') {
      // NT 协议 (useNTLogin) 设备锁无短信通道, sendSmsCode/submitSmsCode 仅老协议可用
      if ((bot as any)?.super?.useNTLogin) {
        throw new Error('NT 协议设备锁不支持短信验证, 请打开验证链接完成')
      }
      const c = String(code ?? '').trim()
      if (!c) throw new Error('缺少验证码')
      if (typeof sendApi !== 'function') throw new Error('该连接不支持 submitSmsCode')
      await sendApi.call(bot, 'submitSmsCode', [c])
      emitLoginEvent(key, { type: 'submit', title: '验证码已提交', message: '正在继续登录...' })
      createSuccessResponse(res, null, '验证码已提交, 正在继续登录...')
    } else if (action === 'retry') {
      // 网页验证完成后手动重新登录: icqq 设备锁无自动回调, 必须重新调用 login()
      if (typeof (bot as any).continueLogin !== 'function') throw new Error('该连接不支持重新登录')
      await (bot as any).continueLogin.call(bot)
      createSuccessResponse(res, null, '已触发重新登录, 若验证已完成将很快上线')
    } else {
      throw new Error(`未知操作: ${action}`)
    }
  } catch (err) {
    createServerErrorResponse(res, `操作失败: ${err instanceof Error ? err.message : String(err)}`)
  }
})
app.use(`${WEB_PREFIX}/api/login`, loginRouter)

/**
 * QQBot 扫码绑定路由 (Web 面板「扫码绑定」):
 *  - POST /start   创建扫码会话, 返回 { id, url, image } (image 为二维码 PNG dataURL, 手机 QQ 扫码后确认绑定)
 *  - POST /status  查询会话状态 (body.sid), phase: pending=等待扫码 / scanned=已绑定(带 appId/appSecret) / expired=过期
 *  - POST /cancel  取消会话 (body.sid)
 * 扫码成功后由前端回填当前卡片表单(qqbotAppId + qqbotClientSecret), 用户点「保存配置」写入
 */
const qrRouter = express.Router()
// 简单 CORS: next dev 跨源联调时允许访问
qrRouter.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin ?? '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})
qrRouter.use(express.json())

qrRouter.post('/start', async (req, res) => {
  try {
    const result = await startQr('web')
    createSuccessResponse(res, result)
  } catch (err) {
    logger.error(`[web] 创建 qqbot 扫码会话失败: ${err instanceof Error ? err.message : String(err)}`)
    createServerErrorResponse(res, `创建扫码任务失败: ${err instanceof Error ? err.message : String(err)}`)
  }
})

qrRouter.post('/status', async (req, res) => {
  try {
    const sid = String((req.body ?? {}).sid ?? '').trim()
    if (!sid) throw new Error('缺少会话 id')
    createSuccessResponse(res, await pollQr(sid))
  } catch (err) {
    createServerErrorResponse(res, `查询扫码状态失败: ${err instanceof Error ? err.message : String(err)}`)
  }
})

qrRouter.post('/cancel', (req, res) => {
  try {
    const sid = String((req.body ?? {}).sid ?? '').trim()
    if (!sid) throw new Error('缺少会话 id')
    cancelQr(sid)
    createSuccessResponse(res, null, '会话已取消')
  } catch (err) {
    createServerErrorResponse(res, `取消失败: ${err instanceof Error ? err.message : String(err)}`)
  }
})
app.use(`${WEB_PREFIX}/api/qqbot/qr`, qrRouter)

app.use(WEB_PREFIX, express.static(webDir))

logger.info(`[web] 配置页面已挂载: ${WEB_PREFIX}/  静态目录: ${webDir}`)