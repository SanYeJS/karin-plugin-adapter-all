import {
  OneBotCreateMessage,
  OneBotCreateNotice,
  OneBotCreateRequest,
  logger,
} from 'node-karin'
import { createOneBot11Transport, type OneBot11Transport } from './transport'
import { OneBot11BaseBot } from './base'
import type { BotConfig } from '../base'

/**
 * 标准 OneBot11 适配器
 * 不依赖任何具体协议端 (SnowLuma/NapCat/Lagrange/go-cqhttp 等) 的扩展 API,
 * 仅使用 OneBot11 规范内的标准 action (base 已实现) + 三种通信方式
 * (正向 WS / 反向 WS / HTTP POST), 适用于任何符合 OneBot11 标准的协议端。
 *
 * 特性:
 *  - 通信方式: 由 createOneBot11Transport 按 cfg.communication 切换
 *  - 身份校验: 不做 app_name 关键字匹配 (标准协议端千差万别), 仅探测版本用于展示
 *  - 扩展能力: 协议端支持的任何 action 均可通过 sendApi(action, params) 直通
 */
export class OneBot11StdBot extends OneBot11BaseBot<OneBot11Transport> {
  constructor (cfg: BotConfig) {
    super(cfg)
    this.raw = this.super = createOneBot11Transport(cfg)
    this.adapter.name = 'OneBot11'
    this.adapter.version = ''
    this.adapter.protocol = 'std'
    this.events()
  }

  /** 执行 OneBot11 action (走统一传输层) */
  protected call (action: string, params?: any) {
    return this.raw.call(action, params)
  }

  /** 探测身份并注册 (幂等) */
  private async probeAndRegister () {
    if (this.verified) return this.register()
    // 服务端模式: 监听成功但协议端尚未接入时跳过
    if (!(this.raw as any).isConnected) return
    const login: any = await this.call('get_login_info')
    const selfId = String(login.user_id)
    this.account = {
      uin: selfId,
      uid: selfId,
      selfId,
      name: login.nickname || '',
      avatar: await this.getAvatarUrl(selfId),
      subId: {},
    }
    await this.probe()
    // 探测完成后才允许注册(含后续重连恢复)
    this.verified = true
    this.register()
  }

  /** 绑定事件 */
  private events () {
    const raw = this.raw
    raw.on('open', () => {
      if (this.adapter.communication === 'webSocketServer' && !this.verified) {
        // 正向 WS(本端服务端): 协议端接入后自动完成身份探测与注册
        this.probeAndRegister().catch((e) => logger.warn(`[OneBot11] 协议端接入后注册失败: ${e?.message || e}`))
        return
      }
      // 仅当身份探测完成(verified)后才注册: 防止重连后幽灵注册
      if (this.verified) this.register()
      this.adapter.connectTime = Date.now()
      logger.bot('info', this.selfId, `[OneBot11] 连接成功: ${this.adapter.address}`)
    })
    raw.on('close', () => this.unregister())
    raw.on('error', (e: any) => logger.warn(`[OneBot11] 连接错误: ${e?.message || e}`))
    raw.on('message', (e) => OneBotCreateMessage(e as never, this as never))
    raw.on('notice', (e) => this.handleNotice(e as any, (n) => OneBotCreateNotice(n, this as never)))
    raw.on('request', (e) => OneBotCreateRequest(e as never, this as never))
  }

  /** 探测服务端身份与版本 (不清洗/映射, 原样打印服务端上报的 app_name) */
  private async probe () {
    try {
      const info: any = await this.call('get_version_info')
      const appName = String(info.app_name ?? '').toLowerCase()
      const version = String(info.app_version ?? info.version ?? '')
      if (version) this.adapter.version = version
      logger.info(`[OneBot11] 已连接: ${appName || '未知协议端'} v${version || '-'} @ ${this.adapter.address}`)
    } catch {
      /* 协议端不支持 get_version_info 时忽略, 不影响接入 */
    }
  }

  /** 启动 */
  async start () {
    if (!this.raw.isConnected) await this.raw.connect()
    if (this.adapter.communication === 'webSocketServer') {
      // 正向 WS(本端服务端): 监听即启动, 等待协议端接入后自动注册
      try {
        await (this.raw as any).waitForClient?.(this.cfg.requestTimeout || 15000)
      } catch {
        logger.warn(`[OneBot11] 等待协议端连接超时: ${this.adapter.address}, 保持监听等待接入`)
        return
      }
      return // 身份探测/注册已由 open 事件完成
    }
    await this.probeAndRegister()
  }
}