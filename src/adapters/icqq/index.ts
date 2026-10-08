import path from 'node:path'
import fs from 'node:fs'
import { karinPathData, logger } from 'node-karin'
import type {
  Contact,
  Elements,
  ForwardOptions,
  GetGroupHighlightsResponse,
  GroupInfo,
  GroupMemberInfo,
  MessageResponse,
  NodeElement,
  SendElement,
  SendMsgResults,
  UserInfo,
} from 'node-karin'
import { createClient, genGroupMessageId, parseGroupMessageId } from 'icqq'
import type { Client, ForwardMessage, Message, MessageElem, PttElem, Sendable, VideoElem } from 'icqq'
import { segment } from 'icqq'
import icqqPkg from 'icqq/package.json' with { type: 'json' }
import { BaseBot } from '../base'
import type { BotConfig } from '../base'
import { clearLoginState, emitLoginEvent } from '@/utils/login-events'
import type { LoginEvent } from '@/utils/login-events'
import { AdapterConvertKarin, KarinConvertAdapter, parseQuotable, getResidScene } from './convert'
import { dispatchMessage, dispatchNotice, dispatchRequest } from './event'

/**
 * icqq 协议适配器: 库直连 QQ(安卓/iPad/Watch等) 协议,
 * 支持 fast(快速登录) / password(密码登录) / qrcode(扫码登录, 需 Watch 平台)。
 * 断线由 icqq 内置 reconn_interval 自动重连, 无需适配器自行处理。
 */
export class IcqqBot extends BaseBot {
  /** icqq 客户端 */
  super: Client
  /** 兼容 BaseBot.stop 的 raw (覆写 stop, 不调用其 close) */
  raw: Client
  /** 是否已绑定事件 (重连时幂等) */
  #eventsBound = false
  /** 是否已主动停止 (停止后不再自动重连) */
  #stopped = false
  /** 连接起始时间 */
  #startTime = 0
  /** 连接时长计时器 */
  #connectTimeTimer: NodeJS.Timeout | null = null
  /** 登录等待 Promise 的 resolver */
  #loginResolve: (() => void) | null = null
  #loginReject: ((err: Error) => void) | null = null
  /** 登录结果 (start 中等待) */
  #loginDone: Promise<void> = Promise.resolve()
  /** 是否已上线 (用于区分登录期错误与会话期异常) */
  #online = false
  /** 滑块已触发 (多通道只跑一轮) */
  #sliderDone = false
  /** 滑块 ticket 已提交 (多通道互斥) */
  #sliderSubmitted = false
  /** 登录超时计时器 (滑块/设备/登录验证环节会重置) */
  #loginTimer: any = null
  /** 被踢下线后的延迟重连计时器 */
  #loginRetryTimer: NodeJS.Timeout | null = null
  /** 最近一次签名服务报错详情 (internal.verbose 暂存, 由登录错误统一打印, 避免日志多行) */
  #lastQsignError = ''

  /** icqq 数据目录: 统一存放在 Karin 数据根 `@karinjs/data/icqq` (不可配置) */
  get #dataDir () {
    return path.join(karinPathData, 'icqq')
  }

  constructor (cfg: BotConfig) {
    super(cfg)
    // 注意: icqq 内部用 `...conf` 展开配置, 显式传 undefined 会覆盖默认值
    // 因此只组装有值的字段, data_dir 始终给稳定默认目录
    const clientConfig: Parameters<typeof createClient>[0] = {
      data_dir: this.#dataDir,
      // icqq 内部日志(启动 banner / 网络包明细等) 完全静默, 由适配器层统一打印
      log_level: 'off',
      ignore_self: true,
      reconn_interval: 5,
    }
    if (cfg.platform) clientConfig.platform = cfg.platform
    if (cfg.ver) clientConfig.ver = cfg.ver
    if (cfg.sign_api_addr) clientConfig.sign_api_addr = cfg.sign_api_addr
    this.super = createClient(clientConfig)
    this.raw = this.super
    this.adapter.name = 'ICQQ'
    this.adapter.version = icqqPkg.version
    this.adapter.platform = 'qq'
    this.adapter.standard = 'icqq'
    this.adapter.protocol = 'icqq'
    // icqq 为库直连长连接
    this.adapter.communication = 'webSocketClient'
  }

  /** 幂等的 for setGroupQQ 登录等待用 */
  __registerBot () {
    this.register()
  }

  /** 断开时注销 Bot */
  __unregisterBot () {
    this.unregister()
  }

  /** 打印当前 Bot 专属日志 */
  logger (level: 'info' | 'error' | 'trace' | 'debug' | 'mark' | 'warn' | 'fatal', ...args: any[]) {
    logger.bot(level, this.account.selfId, ...args)
  }

  /** 上报登录验证事件到 WebUI (SSE 推送到网页面板) */
  #emit (type: LoginEvent['type'], title: string, extra: { message?: string; url?: string; phone?: string } = {}) {
    const uin = String(this.cfg.uin ?? this.super?.uin ?? '')
    emitLoginEvent(uin, { type, title, ...extra })
  }

  /** 直通 icqq API */
  async sendApi (action: string, params?: any) {
    const method = (this.super as any)[action]
    if (typeof method === 'function') return method.apply(this.super, Array.isArray(params) ? params : [params])
    throw new Error(`icqq 客户端无该方法: ${action}`)
  }

  /**
   * 设备锁/登录验证完成后的手动续登 (供 server HTTP 端点调用):
   * icqq 的设备锁(system.login.device)没有自动回调, 用户在网页/手机QQ完成验证后
   * 必须重新调用 login() 让服务端重新校验设备, 验证通过则直接上线。
   */
  async continueLogin () {
    return this.#relogin()
  }

  /** 生成群引用消息 id (reaction 等缺少 rand 的场景) */
  encodeQuoteMsgId (groupId: string, seq: number): string {
    return genGroupMessageId(Number(groupId), 0, seq, 0, Math.floor(Date.now() / 1000), 0)
  }

  /** 解析消息对象 → Karin MessageResponse */
  async #toMessageResponse (m: Message | ForwardMessage): Promise<MessageResponse> {
    const msg = m as { [k: string]: any }
    const userId = String(msg.sender?.user_id ?? msg.from_id ?? m.user_id)
    const nickname = String(msg.sender?.nickname ?? msg.nickname ?? '')
    const isGroup = msg.message_type === 'group'
    const contact = isGroup
      ? { scene: 'group' as const, peer: String(msg.group_id), name: msg.group_name, subId: {} }
      : { scene: 'friend' as const, peer: String(msg.from_id ?? m.user_id), name: '', subId: {} }
    const sender = {
      role: msg.sender?.role ?? 'unknown',
      userId,
      nick: nickname,
      name: nickname,
      card: msg.sender?.card,
      level: msg.sender?.level,
      title: msg.sender?.title,
      sex: msg.sender?.sex,
    }
    return {
      time: m.time,
      messageId: msg.message_id || `${m.seq}-${msg.rand ?? 0}`,
      messageSeq: m.seq,
      contact: contact as Contact,
      sender,
      elements: await AdapterConvertKarin(m, this),
    } as MessageResponse
  }

  /** 绑定客户端事件 (幂等) */
  #bindEvents () {
    if (this.#eventsBound) return
    this.#eventsBound = true
    const client = this.super
    // icqq 内部日志转发: 签名服务报错详情暂存供登录错误统一打印; 其余 Error 级信息(网络异常等)直接输出
    client.on('internal.verbose', (msg: string, level: number) => {
      if (Number(level) !== 2) return
      const s = String(msg ?? '')
      if (/\[qsign\]/.test(s) || /签名api异常/.test(s)) {
        this.#lastQsignError = s
      } else {
        this.logger('error', `[icqq] ${s}`)
      }
    })
    client.on('message', (e: any) => {
      dispatchMessage(e, this).catch((err: any) => this.logger('error', `消息处理错误: ${err.message}`))
    })
    client.on('notice', (e: any) => {
      // icqq 的 notice 与 request 缺省 time, 事件层用 Date.now() 兜底
      dispatchNotice(e, this).catch((err: any) => this.logger('error', `通知处理错误: ${err.message}`))
    })
    client.on('request', (e: any) => {
      dispatchRequest(e, this).catch((err: any) => this.logger('error', `申请处理错误: ${err.message}`))
    })
    client.on('system.online', () => this.#onOnline())
    client.on('system.offline', () => this.#onOffline())
    client.on('system.offline.kickoff', (e: any) => {
      this.#online = false
      this.logger('warn', `[登出] 被服务器踢下线: ${e?.message || ''}`)
      this.__unregisterBot()
      // icqq 对 kickoff 只 terminate 不安排重连, 需手动重新 login
      // (重新登录走 token 续登, 失效时 icqq 内部自动降级密码登录/触发验证流程)
      this.#scheduleRelogin()
    })
    client.on('system.login.qrcode', (e: any) => this.#onQrcode(e.image as Buffer))
    client.on('system.login.slider', (e: any) => {
      this.#resetLoginTimeout()
      this.#onSlider(e?.url)
    })
    client.on('system.login.device', (e: any) => {
      this.#resetLoginTimeout()
      // NT 协议 (useNTLogin) 下腾讯下发的是 double-check 网页验证链接,
      // sendSmsCode/submitSmsCode 是老协议(wtlogin TLV)接口, NT 无短信通道, 强制走网页验证
      const nt = Boolean((this.super as any)?.useNTLogin)
      const phone = nt ? '' : (e?.phone ? String(e?.phone) : '')
      this.#emit('device', '需要设备锁验证', {
        message: nt
          ? 'NT 协议设备锁验证, 请在浏览器打开链接完成, 完成后点击「我已验证, 继续登录」'
          : (phone ? `手机号: ${phone}` : '请在浏览器打开链接完成新设备验证, 完成后点击「我已验证, 继续登录」'),
        url: e?.url,
        phone,
      })
      this.logger('warn', `[登录] 需要设备锁验证: ${e?.url}${nt ? ' (NT 协议, 仅网页验证, 完成后需手动重新登录)' : (phone ? ` (手机号: ${phone})` : ' (无可用手机号, 需网页验证, 完成后需手动重新登录)')}`)
      if (!nt && phone) this.logger('warn', `[登录] 可调用 sendApi('sendSmsCode') 发送短信后 sendApi('submitSmsCode', ['验证码']) 继续`)
    })
    client.on('system.login.auth', (e: any) => this.#onAuth(e))
    client.on('system.login.error', (e: any) => {
      this.#emit('failed', '登录失败', { message: `${e?.message ?? e?.code}` })
      this.logger('error', `[登录] 登录失败: ${e?.message ?? e?.code}`)
      // 已上线后再报登录错误: 属会话异常(重复登录/被踢), 交给 icqq 自动重连, 不再中断委托
      if (this.#online) {
        this.logger('warn', `[登录] 已在线, 忽略该登录错误 (等待 icqq 自动重连)`)
        return
      }
      this.#loginReject?.(new Error(`登录失败: ${e?.message ?? e?.code}`))
    })
  }

  /** 上线: 刷新账号信息 + 注册 + 开启连接计时 */
  #onOnline () {
    const uin = String(this.super.uin || this.cfg.uin || '')
    this.#online = true
    this.account = {
      uin,
      uid: uin,
      selfId: uin,
      name: this.super.nickname || uin,
      avatar: `https://q1.qlogo.cn/g?b=qq&s=0&nk=${uin}`,
      subId: {},
    }
    this.#startTime = Date.now()
    if (this.#connectTimeTimer) clearInterval(this.#connectTimeTimer)
    this.#connectTimeTimer = setInterval(() => {
      this.adapter.connectTime = Date.now() - this.#startTime
    }, 1000)
    this.__registerBot()
    this.#emit('online', '登录成功', { message: this.super.nickname || uin })
    this.logger('info', `登录成功: ${uin}`)
    this.#loginResolve?.()
    this.#loginResolve = null
  }

  /** 掉线: 注销 + 停连接计时 (自动重连由 icqq 内部处理) */
  #onOffline () {
    this.#online = false
    this.__unregisterBot()
    this.#emit('offline', '连接已断开')
    if (this.#connectTimeTimer) {
      clearInterval(this.#connectTimeTimer)
      this.#connectTimeTimer = null
    }
    if (!this.#stopped) {
      this.logger('warn', '[连接] 已掉线, icqq 将自动重连')
    }
  }

  /** 收到登录二维码: 写到本地文件方便扫码 */
  #onQrcode (image: Buffer) {
    const dirPath = this.#dataDir
    const file = path.join(dirPath, `icqq-qrcode.png`)
    try {
      fs.mkdirSync(dirPath, { recursive: true })
      fs.writeFileSync(file, image)
      this.logger('warn', `[登录] 请用手机QQ扫码登录, 二维码已保存: ${file}`)
    } catch (err: any) {
      this.logger('error', `[登录] 二维码保存失败: ${err.message}`)
    }
  }

  /**
   * 需要滑动验证: 按配置选择验证方式 (参考 TRSS Yunzai-ICQQ-Plugin 的半自动化方案)
   *  - auto: 全通道并行, 任一通道拿到 ticket 即提交
   *  - gt / txhelper / manual: 只走指定通道
   */
  #onSlider (url: string) {
    if (this.#sliderDone) return
    this.#sliderDone = true
    const c: any = this.super
    // NT 新协议登录: 腾讯下发的是 NT 验证链接 (如 ti.qq.com 的 sms-verify-login),
    // 该页面要求登录会话, 无会话请求一律 503 (Server: TAPISIX/2.2.2, 与 UA/IP/Referer 无关)。
    // 正确姿势: 用腾讯官方滑块 SDK TCaptcha.js + 链接参数 (aid/uin/sid/login_appid) 内嵌直渲染,
    // 不经 ti.qq.com 页面即可绕开 503 (928100.xyz 链路同机制, 已逆向验证)。
    // NT 登录一律走 CapNT 专用通道 (captcha.928100.xyz 渲染 + captcha-nt-api.928100.xyz 轮询)
    if (c.useNTLogin) {
      this.#emit('progress', '正在准备滑动验证...')
      this.logger('warn', `[登录] NT 协议滑动验证: ${url}`)
      this.#sliderViaCapNT(url)
      return
    }
    const mode = this.cfg.sliderMode || 'gt'
    this.#emit('slider', `需要滑动验证 (方式: ${mode})`, { url })
    this.logger('warn', `[登录] 需要滑动验证 (方式: ${mode}): ${url}`)
    switch (mode) {
      case 'txhelper':
        this.#sliderViaTxHelper(url)
        return
      case 'manual':
        this.#sliderViaTicketFile()
        return
      default: // gt
        this.#sliderViaGT(url)
    }
  }

  /**
   * NT 协议滑动验证专用通道 (对齐 TRSS Yunzai-ICQQ-Plugin):
   * 先检测候选渲染域名可达性 (captcha.928100.xyz 现役 / CapNT.928100.xyz 旧域名),
   * 用首个可达域名渲染腾讯下发的 NT 验证链接完成滑动,
   * 客户端双端点轮询 ticket + randstr 后提交.
   * 注: 渲染站当前把 ticket 提交到 captcha-api-cf.928100.xyz (Cloudflare 后端),
   * captcha-nt-api.928100.xyz (EdgeOne 后端) 为旧渲染站使用, 两片数据不互通, 故全部轮询.
   */
  async #sliderViaCapNT (url: string) {
    const uin = String(this.cfg.uin ?? '')
    const gf = (globalThis as any).fetch
    if (typeof gf !== 'function') {
      this.logger('warn', `[登录] 请打开链接完成滑动验证: ${url}`)
      return
    }
    const apiBases = ['https://captcha-api-cf.928100.xyz', 'https://captcha-nt-api.928100.xyz']
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    // 双端点轮询验证服务: 任一端点返回数据即用 (残留 ticket 也算, 轮询阶段会拿到)
    const getTicket = async (): Promise<any> => {
      for (const base of apiBases) {
        try {
          const res = await (await gf(`${base}/?key=${uin}`)).json()
          if (res && typeof res === 'object') return res
        } catch { /* 单端点失败继续下一个 */ }
      }
      return null
    }
    try {
      // 等待验证服务就绪 (TRSS 逻辑: status=="0" = 无进行中会话, 可开始新验证)
      for (let i = 0; i < 20; i++) {
        const res = await getTicket()
        if (res?.status === '0' || res?.ticket) break
        await sleep(3000)
      }
      // 候选渲染域名按序检测可达性 (captcha.928100.xyz 为现役, CapNT.928100.xyz 为旧域名, 可能已失效)
      const pickRenderBase = async (): Promise<string | null> => {
        const hosts = ['https://captcha.928100.xyz', 'https://CapNT.928100.xyz']
        for (const base of hosts) {
          try {
            const ctrl = new AbortController()
            const timer = setTimeout(() => ctrl.abort(), 5000)
            try {
              const r = await gf(base, { method: 'GET', redirect: 'follow', signal: ctrl.signal })
              if (r && typeof r.status === 'number' && r.status >= 200 && r.status < 500) return base
            } finally { clearTimeout(timer) }
          } catch { /* 该域名不可达, 尝试下一个 */ }
        }
        return null
      }
      let capUrl = url
      try {
        const base = await pickRenderBase()
        const query = new URL(url).searchParams.toString()
        capUrl = base ? `${base}?${query}` : url
        if (!base) this.logger('warn', '[登录] CapNT 渲染服务均不可达, 直接使用腾讯下发原链接')
      } catch { /* 链接格式异常则直接用原链接 */ }
      this.#emit('slider', '需要滑动验证 (NT 协议)', { message: '请点击打开链接，在新窗口完成滑动', url: capUrl })
      this.logger('warn', `[登录] 请打开链接完成滑动验证: ${capUrl}`)
      // 轮询 ticket (对齐 TRSS: 每 3s 一次, 上限 60 次 = 3 分钟; 登录超时兜底 10 分钟)
      let ticket: string | null = null
      for (let i = 0; i < 60; i++) {
        await sleep(3000)
        const res = await getTicket()
        if (res?.ticket) {
          ticket = res.randstr ? `${res.ticket},${res.randstr}` : res.ticket
          break
        }
      }
      if (ticket) await this.#submitSlider(ticket)
      else {
        this.#emit('timeout', '滑动验证超时', { message: '点击「重新上线」可再次尝试' })
        this.logger('warn', '[登录] 滑动验证超时, 可重新上线再试')
      }
    } catch (err: any) {
      this.#emit('failed', '滑动验证失败', { message: err?.message ?? err })
      this.logger('error', `[登录] NT 滑动验证失败: ${err?.message ?? err}`)
    }
  }

  /** 通道2: 网页反代(WS) — 浏览器页面内的验证码请求经 GT 服务转发到本端代发, 兼容新式验证链接 */
  async #sliderViaGTProxy (api: string, sliderUrl: string): Promise<boolean> {
    let ws: any
    try {
      const mod: any = await import('ws')
      ws = new mod.WebSocket(api)
    } catch {
      return false // ws 不可用, 交由网页轮询兜底
    }
    // 等待连接建立 (最多 10s)
    const opened = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { try { ws?.terminate?.() } catch { } resolve(false) }, 10_000)
      ws.on('open', () => { clearTimeout(timer); resolve(true) })
      ws.on('error', () => { clearTimeout(timer); resolve(false) })
      ws.on('close', () => { clearTimeout(timer); resolve(false) })
    })
    if (!opened) return false
    this.logger('warn', `[登录] 请打开完成滑动: ${api}`)
    this.#emit('slider', '需要滑动验证 (GT 网页反代)', { message: '请点击打开链接，在新窗口完成滑动', url: api })
    ws.send(JSON.stringify({ type: 'register', payload: { url: sliderUrl } }))
    // 等待 ticket 下发或代理请求; 最多 180s
    return await new Promise<boolean>((resolve) => {
      let done = false
      const timeout = setTimeout(() => close(), 180_000)
      const close = (ok = false) => {
        if (done) return
        done = true
        clearTimeout(timeout)
        try { ws.terminate?.() } catch { }
        resolve(ok)
      }
      ws.on('message', async (raw: any) => {
        let data: any
        try { data = JSON.parse(raw.toString()) } catch { return }
        switch (data?.type) {
          case 'ticket': {
            const ticket = data.payload?.ticket
            if (ticket) {
              this.logger('info', '[登录] 已获取ticket')
              await this.#submitSlider(ticket)
              close(true)
            }
            break
          }
          case 'handle': {
            // 浏览器页面的验证码请求经 GT 转发到此, 由本端代发 (网页反代)
            const { url: hUrl, ...opts } = data.payload ?? {}
            const gf = (globalThis as any).fetch
            if (!hUrl || typeof gf !== 'function') break
            try {
              const req = await gf(hUrl, opts)
              data.payload = {
                result: Buffer.from(await req.arrayBuffer()).toString('base64'),
                headers: Object.fromEntries((req.headers as any).entries?.() ?? []),
              }
              ws.send(JSON.stringify(data))
            } catch { /* 单次代理失败忽略 */ }
            break
          }
          default: break
        }
      })
      ws.on('close', () => close())
      ws.on('error', () => close())
    })
  }

  /** 通道2: GT 网页验证 — 注册滑块链接, 浏览器访问服务端页面完成滑动, 轮询获取 ticket */
  async #sliderViaGT (url: string) {
    const gf = (globalThis as any).fetch
    if (typeof gf !== 'function') return
    const uin = String(this.cfg.uin ?? '')
    const api = `https://GT.928100.xyz/captcha/slider?key=${uin}`
    // 优先网页反代 (兼容新式验证链接); 不可用时回退网页轮询
    if (await this.#sliderViaGTProxy(api, url)) return
    try {
      await gf(api, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
      })
    } catch {
      return // 服务不可用, 忽略该通道
    }
    this.logger('warn', `[登录] 请打开完成滑动: ${api}`)
    this.#emit('slider', '需要滑动验证 (GT 网页)', { message: '请点击打开链接，在新窗口完成滑动', url: api })
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 3000))
      try {
        const res = await (await gf(api, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ submit: uin }),
        })).json()
        // 兼容顶层 {ticket, randstr} 与 {data: {ticket}} 两种返回结构
        const body = res?.data && typeof res.data === 'object' ? res.data : res
        if (body?.ticket) {
          const ticket = body.randstr ? `${body.ticket},${body.randstr}` : body.ticket
          this.logger('info', '[登录] 已获取ticket')
          return this.#submitSlider(ticket)
        }
      } catch { /* 单次轮询失败忽略 */ }
    }
  }

  /** 通道1: txhelper 请求码 — 浏览器输入请求码完成滑动, 轮询原链接获取 ticket */
  async #sliderViaTxHelper (url: string) {
    const gf = (globalThis as any).fetch
    if (typeof gf !== 'function') return
    const helpUrl = url.replace('ssl.captcha.qq.com', 'txhelper.glitch.me')
    try {
      const code = (await (await gf(helpUrl)).text()).trim()
      // 请求码是一串短字符; 若返回链接/过长文本则视为服务不可用
      if (!code || /^https?:/i.test(code) || code.length > 32) return
      this.logger('warn', `[登录] 请在 txhelper.glitch.me 输入请求码: ${code}`)
      this.#emit('slider', '需要滑动验证 (txhelper)', { message: `请在 txhelper.glitch.me 输入请求码: ${code}`, url: helpUrl })
      for (let i = 0; i < 60; i++) {
        await new Promise(r => setTimeout(r, 3000))
        const res = (await (await gf(helpUrl)).text()).trim()
        if (res && res !== code) return this.#submitSlider(res)
      }
    } catch { /* 不可用则忽略 */ }
  }

  /** 通道3: 手动兜底 — 轮询等待 ticket 文件 (用户完成验证后将 ticket,randstr 写入) */
  async #sliderViaTicketFile () {
    const dirPath = this.#dataDir
    const file = path.join(dirPath, 'slider.ticket')
    this.logger('warn', `[登录] 完成后将 ticket 写入: ${file}`)
    this.#emit('slider', '需要滑动验证 (手动)', { message: `验证完成后将 ticket,randstr 写入: ${file}` })
    for (let i = 0; i < 100; i++) {
      await new Promise(r => setTimeout(r, 2000))
      try {
        if (!fs.existsSync(file)) continue
        const ticket = fs.readFileSync(file, 'utf-8').trim()
        if (!ticket) continue
        fs.rmSync(file, { force: true })
        return this.#submitSlider(ticket)
      } catch { /* 单次读取失败忽略 */ }
    }
  }

  /** 重置登录超时计时 (滑块/设备/登录验证环节等待较久时调用, 避免被超时打断) */
  #resetLoginTimeout (ms = 600_000) {
    if (this.#loginTimer) clearTimeout(this.#loginTimer)
    this.#loginTimer = setTimeout(() => {
      this.#loginTimer = null
      if (this.#loginResolve) {
        this.#loginResolve = null
        this.#loginReject?.(new Error('登录超时'))
      }
    }, ms).unref?.()
  }

  /**
   * 被踢下线/登录失效后延迟手动重连 (icqq 的 kickoff 不会自动重连):
   * 延迟避免刚被踢就立刻撞上服务器风控; 重新 login 由 icqq 内部走 token → 密码降级,
   * 若再次触发设备锁/滑块验证会由对应事件处理并推送到 WebUI 继续引导。
   */
  #scheduleRelogin (delayMs = 5000) {
    if (this.#stopped) return
    if (this.#loginRetryTimer) clearTimeout(this.#loginRetryTimer)
    this.#loginRetryTimer = setTimeout(() => {
      this.#loginRetryTimer = null
      const c: any = this.super
      if (typeof c.login !== 'function' || c.isOnline()) return
      const uin = this.cfg.uin !== undefined && this.cfg.uin !== '' ? Number(this.cfg.uin) : undefined
      this.logger('warn', `[登录] 被踢下线, ${delayMs / 1000}秒后尝试重新登录...`)
      const p: Promise<any> | undefined = this.cfg.password ? c.login(uin, this.cfg.password) : c.login(uin)
      if (p?.catch) p.catch((err: any) => this.logger('error', `[登录] 重新登录失败: ${err?.message ?? err}`))
    }, delayMs).unref?.()
  }

  /** system.login.auth — 设备/登录验证自动化 (流程同 TRSS: 928100.xyz 验证服务) */
  async #onAuth (e: any) {
    this.#resetLoginTimeout()
    const uin = String(this.cfg.uin ?? '')
    const gf = (globalThis as any).fetch
    if (typeof gf !== 'function') {
      this.logger('warn', `[登录] 需要登录验证: ${e?.url}`)
      return
    }
    const api = (path: string) => `https://captcha-api.928100.xyz/${path}?uin=${uin}`
    const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
    const authUrl = `https://Auth.928100.xyz?uin=${uin}`
    this.#emit('auth', '需要登录验证', { message: '请点击打开链接，在新窗口完成验证', url: authUrl })
    this.logger('warn', `[登录] 请打开链接完成登录验证: ${authUrl}`)

    const checkStatus = async (): Promise<boolean> => {
      for (let i = 0; i < 60; i++) {
        try {
          const res = await (await gf(api('get-verify-status'))).json()
          if (res?.status === 1) return true
          if (res?.status !== 0) this.logger('warn', `[登录] 验证错误: ${JSON.stringify(res)}`)
        } catch (err: any) {
          this.logger('error', `[登录] 验证请求错误: ${err?.message ?? err}`)
        }
        await sleep(5000)
      }
      return false
    }

    // 已有设备缓存: 直接等待验证状态
    try {
      const res = await (await gf(api('query-bound-phone'))).json()
      if (res?.retcode === 0) {
        this.logger('info', '[登录] 存在设备缓存, 正在验证...')
        if (await checkStatus()) return this.#relogin()
        return this.#authFail()
      }
    } catch (err: any) {
      this.logger('warn', `[登录] 查询设备缓存失败: ${err?.message ?? err}`)
    }

    // 无缓存: 等用户在验证页完成后轮询 ticket, 再上传设备信息
    let ticket: any
    for (let i = 0; i < 60; i++) {
      try {
        const res = await (await gf(api('get-ticket'))).json()
        if (res?.status === 0 && res.data?.ticket && res.data?.randstr) {
          ticket = res.data
          break
        }
        if (res?.status !== 1) this.logger('warn', `[登录] ticket 错误: ${JSON.stringify(res)}`)
      } catch (err: any) {
        this.logger('error', `[登录] ticket 请求错误: ${err?.message ?? err}`)
      }
      await sleep(5000)
    }
    if (!ticket) return this.#authFail('ticket 验证超时')

    const sig = decodeURIComponent(String(e?.url ?? '')).match(/sig=([^&]+)/)?.[1]
    const payload = {
      version: (this.super as any).apk?.ver,
      sig,
      ticket: ticket.ticket,
      randstr: ticket.randstr,
      guid: e?.device?.guid,
      qimei: e?.device?.qimei,
      appid: e?.device?.subappid,
    }
    this.logger('info', '[登录] 上传设备信息')
    for (let i = 0; i < 5; i++) {
      try {
        const res = await (await gf(api('upload-qqInfo'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })).json()
        if (res?.status === 0) {
          this.#emit('progress', '设备信息上传成功', { message: '正在等待验证结果...' })
          this.logger('info', '[登录] 设备信息上传成功, 正在验证...')
          if (await checkStatus()) return this.#relogin()
          return this.#authFail()
        }
        this.logger('warn', `[登录] 设备信息错误: ${JSON.stringify(res)}`)
      } catch (err: any) {
        this.logger('error', `[登录] 设备信息上传错误: ${err?.message ?? err}`)
      }
      await sleep(5000)
    }
    return this.#authFail('设备信息上传超时')
  }

  /** 登录验证通过后重新登录 */
  async #relogin () {
    const uin = this.cfg.uin !== undefined && this.cfg.uin !== '' ? Number(this.cfg.uin) : undefined
    this.#emit('relogin', '验证已通过', { message: '正在重新登录...' })
    try {
      await this.super.login(uin, this.cfg.password)
      this.logger('info', '[登录] 验证已通过, 重新登录中...')
    } catch (err: any) {
      this.logger('warn', `[登录] 重新登录失败: ${err?.message ?? err}`)
    }
  }

  /** 登录验证流程失败 */
  #authFail (reason = '登录验证超时') {
    this.#emit('failed', '登录验证失败', { message: reason })
    this.logger('warn', `[登录] ${reason}`)
    this.#loginReject?.(new Error(reason))
  }

  /** 提交滑块 ticket (多通道互斥, 成功后其余通道自动放弃) */
  async #submitSlider (ticket: string) {
    if (this.#sliderSubmitted) return
    this.#sliderSubmitted = true
    try {
      await this.super.submitSlider(ticket)
      this.#emit('submit', '滑动验证已通过', { message: '正在继续登录...' })
      this.logger('info', '[登录] 已提交滑动验证, 正在继续登录...')
    } catch (err: any) {
      this.#sliderSubmitted = false
      this.logger('error', `[登录] 滑动验证提交失败: ${err?.message ?? err}`)
      this.#loginReject?.(new Error(`滑动验证提交失败: ${err?.message ?? err}`))
    }
  }

  /** 启动: 绑定事件 + 登录 */
  async start () {
    if (this.#stopped) this.#stopped = false
    this.#bindEvents()
    if (this.super.isOnline()) {
      this.#onOnline()
      return
    }
    const uin = this.cfg.uin !== undefined && this.cfg.uin !== '' ? Number(this.cfg.uin) : undefined
    const password = this.cfg.password
    const loginType = this.cfg.loginType || (password ? 'password' : uin ? 'fast' : 'qrcode')

    this.#loginDone = new Promise<void>((resolve, reject) => {
      this.#loginResolve = resolve
      this.#loginReject = reject
      // 超时兜底: 滑块/设备/登录验证等环节会重置计时 (见 #resetLoginTimeout)
      this.#resetLoginTimeout()
    })

    try {
      // 新一轮登录开始前清空上次签名服务报错缓存
      this.#lastQsignError = ''
      const loginTask = (async () => {
        if (loginType === 'password') {
          if (!uin || !password) throw new Error('密码登录需要配置 uin 和 password')
          await this.super.login(uin, password)
        } else if (loginType === 'fast') {
          if (!uin) throw new Error('快速登录需要配置 uin')
          await this.super.login(uin)
        } else {
          // 扫码登录: 无参 login (需要 platform=Watch)
          if (this.cfg.platform && this.cfg.platform !== 3) {
            this.logger('warn', '[登录] 扫码登录建议使用 Watch 平台 (platform=3)')
          }
          await this.super.login()
        }
      })()
      this.logger('info', `[登录] 正在登录 ${uin ?? '(扫码)'} (${loginType})...`)
      // login() 本身可能挂起(签名服务/网络请求无响应, icqq axios 无超时):
      // 超时兜底, 否则 start 永久 pending 会阻塞热更新与后续 boot
      const hangGuard = new Promise<never>((_, reject) => {
        const timer = setTimeout(() => reject(new Error('登录请求无响应超时')), 60_000)
        timer.unref?.()
      })
      await Promise.race([loginTask, hangGuard])
    } catch (err: any) {
      // icqq 签名服务异常(-90): 登录关键包拿不到签名会被库直接拒绝
      // ApiRejection 是普通对象(无 stack), 需 JSON 序列化; Error 则打印堆栈
      if (err?.code === -90 || /签名api/.test(String(err?.message ?? ''))) {
        const detail = (err as Error)?.stack ?? (err && typeof err === 'object' ? JSON.stringify(err) : String(err ?? ''))
        // 合并 internal.verbose 暂存的签名服务报错详情, 一行打印完整根因
        const qsign = this.#lastQsignError ? ` | ${this.#lastQsignError}` : ''
        this.logger('error', `[登录] 签名api异常: ${detail}${qsign}`)
      }
      if (this.#loginTimer) {
        clearTimeout(this.#loginTimer)
        this.#loginTimer = null
      }
      throw err
    }

    // 等待 system.online / system.login.error 结果
    await this.#loginDone
  }

  /** 停止: 登出并注销 (热更新/停用时调用) */
  async stop () {
    this.#stopped = true
    if (this.#loginRetryTimer) {
      clearTimeout(this.#loginRetryTimer)
      this.#loginRetryTimer = null
    }
    this.unregister()
    clearLoginState(String(this.cfg.uin ?? this.super?.uin ?? ''))
    if (this.#connectTimeTimer) {
      clearInterval(this.#connectTimeTimer)
      this.#connectTimeTimer = null
    }
    try {
      await this.super.logout()
    } catch {
      /* 忽略登出异常 */
    }
  }

  // ===== 消息 =====
  async sendMsg (contact: Contact, elements: Array<SendElement>): Promise<SendMsgResults> {
    const result: SendMsgResults = {
      messageId: '',
      time: 0,
      rawData: {},
      message_id: '',
      messageTime: 0,
    }
    const { message, source } = await KarinConvertAdapter(elements)
    let ret
    if (contact.scene === 'group') {
      ret = await this.super.sendGroupMsg(Number(contact.peer), message, source)
    } else if (contact.scene === 'friend') {
      ret = await this.super.sendPrivateMsg(Number(contact.peer), message, source)
    } else if (contact.scene === 'groupTemp') {
      // 群临时会话走私聊通道
      ret = await this.super.sendPrivateMsg(Number(contact.peer), message, source)
    } else {
      throw new Error(`不支持的场景: ${contact.scene}`)
    }
    result.messageId = ret.message_id
    result.time = ret.time
    result.rawData = ret
    result.message_id = ret.message_id
    result.messageTime = ret.time
    return result
  }

  async sendForwardMsg (contact: Contact, elements: Array<NodeElement>, _options?: ForwardOptions) {
    const userId = Number(this.account.selfId) || 0
    const nickname = this.account.name
    const nodes: MessageElem[] = []
    for (const v of elements) {
      const nodeUserId = v.subType === 'fake' ? Number(v.userId) : userId
      const nodeNickname = v.subType === 'fake' ? v.nickname : nickname
      if (v.subType === 'fake') {
        const { message } = await KarinConvertAdapter(v.message)
        nodes.push(segment.fake(nodeUserId, message, nodeNickname))
      } else {
        // 本地消息: 拉取转发内容
        try {
          const msgs = await this.getForwardMsg(v.messageId)
          const first = msgs[0]
          const { message } = first ? await KarinConvertAdapter(first.elements) : { message: ['' as any] }
          nodes.push(segment.fake(nodeUserId, message, nodeNickname))
        } catch {
          nodes.push(segment.fake(nodeUserId, ['' as any], nodeNickname))
        }
      }
    }
    if (nodes.length === 0) throw new Error('合并转发内容为空')
    const result = { messageId: '', forwardId: '' }
    const ret = contact.scene === 'friend'
      ? await this.super.sendPrivateMsg(Number(contact.peer), nodes)
      : await this.super.sendGroupMsg(Number(contact.peer), nodes)
    result.messageId = ret.message_id
    return result
  }

  async recallMsg (contact: Contact, messageId: string): Promise<void> {
    await this.super.deleteMsg(messageId)
  }

  async getMsg (Contact: Contact | string, messageId?: string): Promise<MessageResponse> {
    const mid = typeof Contact === 'string' ? Contact : messageId!
    const m = await this.super.getMsg(mid)
    if (!m) throw new Error(`消息不存在: ${mid}`)
    return await this.#toMessageResponse(m)
  }

  async getHistoryMsg (contact: Contact, startMsgSeq: string | number, count: number): Promise<MessageResponse[]> {
    const result: MessageResponse[] = []
    if (contact.scene === 'group') {
      const seq = typeof startMsgSeq === 'string' ? parseSeq(startMsgSeq) : startMsgSeq
      const msgs = await this.super.pickGroup(Number(contact.peer)).getChatHistory(seq > 0 ? seq : undefined, count)
      for (const m of msgs) result.push(await this.#toMessageResponse(m))
    } else {
      const seq = typeof startMsgSeq === 'string' ? parseSeq(startMsgSeq) : startMsgSeq
      const msgs = await this.super.pickFriend(Number(contact.peer)).getChatHistory(seq > 0 ? seq : undefined, count)
      for (const m of msgs) result.push(await this.#toMessageResponse(m))
    }
    return result
  }

  async getForwardMsg (resId: string): Promise<Array<MessageResponse>> {
    // 群 resid 必须经 pickGroup 解包 (Client 版本固定私聊场景), 收侧已记录归属场景
    const scene = getResidScene(resId)
    const msgs = scene
      ? await (scene.scene === 'group'
        ? this.super.pickGroup(Number(scene.peer))
        : this.super.pickFriend(Number(scene.peer))
      ).getForwardMsg(resId)
      : await this.super.getForwardMsg(resId)
    const result: MessageResponse[] = []
    for (const m of msgs) {
      result.push(await this.#toMessageResponse(m))
    }
    return result
  }

  async setMsgReaction (contact: Contact, messageId: string, faceId: number | string, isSet: boolean): Promise<void> {
    if (contact.scene !== 'group') throw new Error('仅支持群聊设置表情回应')
    const info = parseMessageId(messageId)
    if (!info) throw new Error(`无法解析消息 id: ${messageId}`)
    const group = this.super.pickGroup(info.group_id)
    if (isSet) await group.setReaction(info.seq, String(faceId))
    else await group.delReaction(info.seq, String(faceId))
  }

  // ===== 群管 =====
  async groupKickMember (groupId: string, targetId: string, rejectAddRequest?: boolean, _kickReason?: string): Promise<void> {
    await this.super.setGroupKick(Number(groupId), Number(targetId), rejectAddRequest)
  }

  async setGroupMute (groupId: string, targetId: string, duration: number): Promise<void> {
    await this.super.setGroupBan(Number(groupId), Number(targetId), duration)
  }

  async setGroupAllMute (groupId: string, isBan: boolean): Promise<void> {
    await this.super.setGroupWholeBan(Number(groupId), isBan)
  }

  /** 发送群公告 (karin 无标准接口, icqq SDK Group.announce, 需管理员权限) */
  async groupAnnounce (groupId: string, content: string): Promise<boolean> {
    return this.super.pickGroup(Number(groupId)).announce(content)
  }

  async setGroupAdmin (groupId: string, targetId: string, isAdmin: boolean): Promise<void> {
    await this.super.setGroupAdmin(Number(groupId), Number(targetId), isAdmin)
  }

  async setGroupMemberCard (groupId: string, targetId: string, card: string): Promise<void> {
    await this.super.setGroupCard(Number(groupId), Number(targetId), card)
  }

  async setGroupName (groupId: string, groupName: string): Promise<void> {
    await this.super.setGroupName(Number(groupId), groupName)
  }

  async setGroupQuit (groupId: string, isDismiss: boolean): Promise<void> {
    const info = await this.super.getGroupMemberInfo(Number(groupId), Number(this.account.selfId || 0))
    if (info && info.role === 'owner' && !isDismiss) return
    await this.super.setGroupLeave(Number(groupId))
  }

  async setGroupMemberTitle (groupId: string, targetId: string, title: string): Promise<void> {
    await this.super.setGroupSpecialTitle(Number(groupId), Number(targetId), title)
  }

  // ===== 查询 =====
  async getGroupInfo (groupId: string, noCache?: boolean): Promise<GroupInfo> {
    const info = await this.super.getGroupInfo(Number(groupId), noCache)
    let admins: GroupInfo['admins'] = []
    try {
      for (const [uid, m] of await this.super.getGroupMemberList(Number(groupId), noCache)) {
        if (m.role === 'owner' || m.role === 'admin') {
          admins.push({ userId: String(uid), name: m.card || m.nickname, role: m.role })
        }
      }
    } catch {
      // 群成员获取失败时忽略 admin 推导
    }
    return {
      groupId: String(info.group_id),
      groupName: info.group_name,
      maxMemberCount: info.max_member_count,
      memberCount: info.member_count,
      admins,
      avatar: `https://p.qlogo.cn/gh/${groupId}/${groupId}/640`,
    } as GroupInfo
  }

  async getGroupList (_refresh?: boolean): Promise<Array<GroupInfo>> {
    const groups: GroupInfo[] = []
    for (const [gid, info] of this.super.getGroupList()) {
      groups.push({
        groupId: String(gid),
        groupName: info.group_name,
        maxMemberCount: info.max_member_count,
        memberCount: info.member_count,
        admins: [],
        avatar: `https://p.qlogo.cn/gh/${gid}/${gid}/0`,
      } as GroupInfo)
    }
    return groups
  }

  async getGroupMemberInfo (groupId: string, targetId: string, refresh?: boolean): Promise<GroupMemberInfo> {
    const m = await this.super.getGroupMemberInfo(Number(groupId), Number(targetId), refresh)
    return {
      userId: String(m.user_id),
      role: m.role,
      nick: m.nickname,
      age: m.age ?? 0,
      uniqueTitle: m.title,
      card: m.card,
      joinTime: m.join_time,
      lastActiveTime: m.last_sent_time,
      level: m.level,
      shutUpTime: m.shutup_time || undefined,
      sex: (m as any).sex,
      sender: {
        userId: String(m.user_id),
        nick: m.nickname,
        name: m.nickname,
        role: m.role,
        card: m.card,
        level: m.level,
        title: m.title,
      },
    } as GroupMemberInfo
  }

  async getGroupMemberList (groupId: string, refresh?: boolean): Promise<Array<GroupMemberInfo>> {
    const map = await this.super.getGroupMemberList(Number(groupId), refresh)
    const info: GroupMemberInfo[] = []
    for (const [uid, m] of map) {
      info.push({
        userId: String(uid),
        role: m.role,
        nick: m.nickname,
        age: m.age ?? 0,
        uniqueTitle: m.title,
        card: m.card,
        joinTime: m.join_time,
        lastActiveTime: m.last_sent_time,
        level: m.level,
        shutUpTime: m.shutup_time || undefined,
        sex: (m as any).sex,
        sender: {
          userId: String(uid),
          nick: m.nickname,
          name: m.nickname,
          role: m.role,
          card: m.card,
          level: m.level,
          title: m.title,
        },
      })
    }
    return info
  }

  // ===== 精华 (icqq 无获取精华列表 API) =====
  async getGroupHighlights (_groupId: string, _page: number, _pageSize: number): Promise<Array<GetGroupHighlightsResponse>> {
    return []
  }

  async setGroupHighlights (groupId: string, messageId: string, create: boolean): Promise<void> {
    if (create) {
      await this.super.setEssenceMessage(messageId)
    } else {
      await this.super.removeEssenceMessage(messageId)
    }
  }

  async getStrangerInfo (targetId: string): Promise<UserInfo> {
    const info = await this.super.pickUser(Number(targetId)).getSimpleInfo()
    return {
      userId: String(info.user_id),
      nick: info.nickname,
      qid: '',
      remark: '',
      level: 0,
      age: info.age,
      sex: info.sex,
    } as UserInfo
  }

  async getFriendList (_refresh?: boolean): Promise<Array<UserInfo>> {
    const info: UserInfo[] = []
    for (const [uid, f] of this.super.getFriendList()) {
      info.push({
        userId: String(uid),
        nick: f.nickname,
        qid: '',
        remark: f.remark,
        sex: f.sex,
      } as UserInfo)
    }
    return info
  }

  async sendLike (targetId: string, count: number): Promise<void> {
    await this.super.sendLike(Number(targetId), count)
  }

  async getAvatarUrl (userId: string, size?: 0 | 40 | 100 | 140): Promise<string> {
    return `https://q1.qlogo.cn/g?b=qq&s=${size || 0}&nk=${userId}`
  }

  async getGroupAvatarUrl (groupId: string, size?: 0 | 40 | 100 | 140, _history?: number): Promise<string> {
    return `https://p.qlogo.cn/gh/${groupId}/${groupId}/${size || 0}`
  }

  async pokeUser (contact: Contact, targetId: string, count: number = 1): Promise<boolean> {
    let pokeFunc: (() => Promise<boolean>) | undefined
    if (contact.scene === 'group') pokeFunc = () => this.super.sendGroupPoke(Number(contact.peer), Number(targetId))
    if (contact.scene === 'friend') pokeFunc = () => this.super.sendGroupPoke(Number(this.super.uin || this.cfg.uin), Number(targetId)).then(() => true)
    if (!pokeFunc) throw new Error(`不支持的场景: ${contact.scene}`)
    for (let i = 0; i < count; i++) await pokeFunc()
    return true
  }

  // ===== 审批 =====
  async setFriendApplyResult (requestId: string, isApprove: boolean, remark?: string): Promise<void> {
    await this.super.setFriendAddRequest(requestId, isApprove, remark)
  }

  async setGroupApplyResult (requestId: string, isApprove: boolean, denyReason?: string): Promise<void> {
    await this.super.setGroupAddRequest(requestId, isApprove, denyReason)
  }

  async setInvitedJoinGroupResult (requestId: string, isApprove: boolean): Promise<void> {
    await this.super.setGroupAddRequest(requestId, isApprove)
  }

  // ===== 文件 =====
  async getFileUrl (contact: Contact, fileId: string): Promise<string> {
    if (contact.scene === 'group') {
      const res = await this.super.pickGroup(Number(contact.peer)).getFileUrl(fileId)
      return res
    }
    const res = await this.super.pickFriend(Number(contact.peer)).getFileUrl(fileId)
    return res
  }

  /** 获取视频播放地址 (NT 视频由会话接口自行解码 protobuf 载荷, 普通视频用 fid+md5) */
  async getVideoUrl (contact: Contact, elem: VideoElem): Promise<string | null> {
    if ((elem as VideoElem & { nt?: boolean }).nt) {
      const target = contact.scene === 'group'
        ? this.super.pickGroup(Number(contact.peer))
        : this.super.pickFriend(Number(contact.peer))
      return target.getNTVideoUrl(elem)
    }
    if (!elem.fid || !elem.md5) return null
    return this.super.getVideoUrl(String(elem.fid), Buffer.from(String(elem.md5), 'base64'))
  }

  /** 获取语音播放地址 (带 fid 走会话 NT 接口, 否则用收侧自带 url) */
  async getRecordUrl (contact: Contact, elem: PttElem): Promise<string | null> {
    const target = contact.scene === 'group'
      ? this.super.pickGroup(Number(contact.peer))
      : this.super.pickFriend(Number(contact.peer))
    return (await target.getPttUrl(elem)) ?? null
  }

  async uploadFile (contact: Contact, file: string, name: string, folder?: string): Promise<void> {
    if (contact.scene === 'group') {
      await this.super.pickGroup(Number(contact.peer)).uploadFile(file, folder ?? '/', name)
    } else {
      await this.super.pickFriend(Number(contact.peer)).sendFile(file, name)
    }
  }

  async uploadGroupFile (groupId: string, file: string, name?: string): Promise<boolean> {
    await this.super.pickGroup(Number(groupId)).uploadFile(file, '/', name || '')
    return true
  }

  async delGroupFile (groupId: string, fileId: string): Promise<boolean> {
    await this.super.pickGroup(Number(groupId)).fs.rm(fileId)
    return true
  }

  async getGroupFileList (groupId: string, folderId?: string) {
    const fs = this.super.pickGroup(Number(groupId)).fs
    const list = await fs.dir(folderId || '/', 0, 100)
    return {
      files: list.filter((v): v is { is_dir: false } & typeof v => !v.is_dir).map(v => ({
        fid: v.fid,
        name: v.name,
        size: (v as any).size ?? 0,
        uploadTime: v.create_time,
        expireTime: (v as any).duration ?? 0,
        modifyTime: v.modify_time,
        downloadCount: (v as any).download_times ?? 0,
        uploadId: String(v.user_id ?? ''),
        uploadName: '',
        sha1: (v as any).sha1 ?? '',
        sha3: '',
        md5: (v as any).md5 ?? '',
      })),
      folders: list.filter((v): v is { is_dir: true } & typeof v => v.is_dir).map(v => ({
        id: v.fid,
        name: v.name,
        fileCount: (v as any).file_count ?? 0,
        createTime: v.create_time,
        creatorId: String(v.user_id ?? ''),
        creatorName: '',
      })),
    }
  }

  async createGroupFolder (groupId: string, name: string) {
    const stat = await this.super.pickGroup(Number(groupId)).fs.mkdir(name)
    return { id: stat.fid, usedSpace: '0' }
  }

  async renameGroupFolder (groupId: string, folderId: string, name: string): Promise<boolean> {
    await this.super.pickGroup(Number(groupId)).fs.rename(folderId, name)
    return true
  }

  async delGroupFolder (groupId: string, folderId: string): Promise<boolean> {
    await this.super.pickGroup(Number(groupId)).fs.rm(folderId)
    return true
  }

  // ===== 凭证/头像 =====
  async getCookies (domain: string): Promise<{ cookie: string }> {
    return { cookie: this.super.getCookies(domain as any) }
  }

  async getCredentials (domain: string): Promise<{ cookies: string; csrf_token: number }> {
    const cookies = (await this.getCookies(domain)).cookie
    const token = (await this.getCSRFToken()).token
    return { cookies, csrf_token: token }
  }

  async getCSRFToken (): Promise<{ token: number }> {
    const token = this.super.getCsrfToken()
    return { token: Number.isFinite(token) ? token : 0 }
  }

  async setAvatar (uri: string): Promise<void> {
    await this.super.setPortrait(uri as any)
  }
}

/** 从 cqhttp message_id 解析 seq */
const parseSeq = (messageId: string): number => {
  const q = parseQuotable(messageId)
  return q?.seq ?? 0
}

/** 解析 cqhttp message_id → { group_id, seq } (仅供群场景) */
const parseMessageId = (messageId: string): { group_id: number; seq: number } | undefined => {
  try {
    const info = parseGroupMessageId(messageId)
    return { group_id: info.group_id, seq: info.seq }
  } catch {
    return undefined
  }
}

/** icqq 协议 bot 工厂 */
export const createIcqqBot = (cfg: BotConfig): IcqqBot | undefined => {
  return new IcqqBot(cfg)
}