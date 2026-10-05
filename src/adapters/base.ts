import { AdapterBase, registerBot, unregisterBot } from 'node-karin'

/** 支持的协议端 */
export type Protocol = 'onebot11' | 'onebot12' | 'icqq' | 'milky' | 'kook' | 'qqbot' | 'douyin' | 'wxoc'
/** OneBot11 下的具体实现 */
export type OneBot11Impl = 'snowluma' | 'napcat' | 'lagrange' | 'std'
/** OneBot11 通信方式 */
export type OneBot11Communication = 'http' | 'ws' | 'ws-reverse' | 'sse'

/** 消息正则替换规则 (kook/qqbot 入站消息应用) */
export type MsgReplaceRule = { match: string; to: string }

/** Bot配置 通用字段 */
export interface BotConfig {
  /** 是否启用 */
  enable: boolean
  /** 协议端 */
  protocol: Protocol
  /**
   * 消息正则替换总开关 (kook/qqbot): 默认开启, 设为 false 时规则不生效
   */
  msgReplaceEnable?: boolean
  /**
   * 消息正则替换 (kook/qqbot): 收到消息后对文本段依次应用正则替换,
   * 如 { match: '^\\s*\\\\/', to: '#' } 可将 /命令 转为 Karin 默认前缀的 #命令
   * (注意: 匹配正则以字符串形式书写, 反斜杠需转义)
   */
  msgReplace?: Array<MsgReplaceRule>
  /** onebot11 时的具体实现 默认snowluma */
  impl?: OneBot11Impl
  /**
   * onebot11 通信方式 默认 ws (正向 WebSocket):
   *  - ws        正向 WS: 本端作为服务端 监听 url(本端地址) 协议端主动连接
   *  - ws-reverse 反向 WS: 本端作为客户端 连接 url(协议端 WS 地址)
   *  - http      HTTP: url 为协议端 HTTP API 地址 事件由协议端 POST 到 eventUrl
   *  - sse       HTTP SSE: url 为协议端 HTTP API 地址 事件流使用 eventUrl
   */
  communication?: OneBot11Communication
  /** 连接地址 (含义随 communication 变化) */
  url: string
  /** HTTP/SSE 模式下的事件地址 (如 http://127.0.0.1:8080/onebot) 其他模式忽略 */
  eventUrl?: string
  /** 鉴权Token 可选 (配置则传输时携带 / 服务端模式时校验连接方) */
  accessToken?: string
  /** 断线重连 */
  reconnect?: boolean
  /** 心跳间隔(ms) 不填则使用协议端默认 */
  heartbeatInterval?: number
  /** API请求超时(ms) 默认15000 */
  requestTimeout?: number
  /**
   * milky 事件接收方式 默认 ws:
   *  - ws      WebSocket: 本端连接 ws://{url}/event (Bearer 鉴权, 心跳+重连)
   *  - sse     SSE: 本端 GET {url}/event 订阅事件流 (Bearer 鉴权, 重连)
   *  - webhook 本端 HTTP 服务接收协议端 POST 推送 (需配置 eventUrl 为本端监听地址)
   */
  eventMode?: 'ws' | 'sse' | 'webhook'
  /* ==================== icqq 专属 (协议直连 不依赖 url) ==================== */
  /** icqq 登录的 QQ 号 (登录时传入) */
  uin?: number | string
  /** 密码登录时的密码 */
  password?: string
  /** icqq 登录方式: fast=快速登录(token优先) password=密码登录 qrcode=扫码登录(需 platform=Watch) */
  loginType?: 'fast' | 'password' | 'qrcode'
  /** icqq 登录协议 对应 Platform 枚举: Android=1 aPad=2 Watch=3 iMac=4 iPad=5 Tim=6 Custom=7 */
  platform?: number
  /** icqq 协议版本 如 "2.1.7" */
  ver?: string
  /** 签名服务地址 如 http://127.0.0.1:8080/ */
  sign_api_addr?: string
  /**
   * icqq 滑动验证方式 默认 gt:
   *  - gt       GT网页验证: 浏览器打开服务端页面完成滑动
   *  - txhelper txhelper请求码: 浏览器输入请求码完成滑动 (仅支持 ssl.captcha.qq.com 类链接)
   *  - manual   手动: 完成滑动后把 ticket,randstr 写入 data/icqq/slider.ticket
   */
  sliderMode?: 'gt' | 'txhelper' | 'manual'
  /* ==================== kook 专属 (官方 API 直连 url 可留空) ==================== */
  /** Kook Bot Token (申请机器人后由开发者后台生成) */
  kookToken?: string
  /** Kook 事件接收方式: ws=官方 Gateway / webhook=本端 HTTP 服务接收 默认 ws */
  kookEventMode?: 'ws' | 'webhook'
  /** Kook webhook 模式下的本端监听地址 (如 0.0.0.0:8091) 协议端回调填 http://公网IP:8091/webhook/kook */
  kookWebhookUrl?: string
  /* ==================== qqbot 专属 (官方 API 直连 url 可留空) ==================== */
  /** QQ开放平台机器人 AppID (开放平台「开发设置」获取) */
  qqbotAppId?: string
  /** QQ开放平台机器人 AppSecret (开放平台「开发设置」获取) 官方接入票据之二, 通过 AccessToken 机制鉴权 (鉴权头 QQBot {token}) */
  qqbotClientSecret?: string
  /** QQBot 事件接收方式: ws=官方 WebSocket Gateway / webhook=本端 HTTP 服务接收 默认 ws */
  qqbotEventMode?: 'ws' | 'webhook'
  /** QQBot webhook 模式下的本端监听地址 (如 0.0.0.0:8092) 开放平台回调填 http://公网IP:8092/webhook/qqbot */
  qqbotWebhookUrl?: string
  /* ==================== douyin 专属 (会话存储 data/douyin-accounts, 扫码登录后回填) ==================== */
  /** 抖音账号数字 uid (扫码登录成功后的 platformUid, 匹配本地会话) */
  douyinUid?: string
  /** 抖音账号昵称 (显示用) */
  douyinName?: string
  /* ==================== wxoc 专属 (微信 Claw ilink 协议, 扫码登录后回填 url 可留空) ==================== */
  /** 微信 Claw 登录凭证 bot_token */
  wxocToken?: string
  /** ilink 机器人 ID */
  wxocAccountId?: string
  /** ilink 用户 ID */
  wxocUserId?: string
  /** 账号昵称 (显示用) */
  wxocNickname?: string
  /** 登录返回的 API 地址 (可选, 留空用默认) */
  wxocBaseUrl?: string
}

/** 协议端统一基类 各端继承实现自己的连接与API */
export abstract class BaseBot<T = any> extends AdapterBase<T> {
  constructor (readonly cfg: BotConfig) {
    super()
    // icqq 为协议直连 / kook、qqbot、douyin、wxoc 走官方 API 均不强制 url (留空用官方默认地址)
    if (!['icqq', 'kook', 'qqbot', 'douyin', 'wxoc'].includes(cfg.protocol) && !cfg.url) throw new Error(`[${this.constructor.name}] 缺少 url 配置`)
    this.adapter.address = cfg.protocol === 'icqq'
      ? `icqq:${cfg.uin || ''}`
      : cfg.protocol === 'kook'
        ? `kook:${cfg.kookToken || ''}`
        : cfg.protocol === 'qqbot'
          ? `qqbot:${cfg.qqbotAppId || ''}`
          : cfg.protocol === 'douyin'
            ? `douyin:${cfg.douyinName || cfg.douyinUid || ''}`
            : cfg.protocol === 'wxoc'
              ? `wxoc:${cfg.wxocNickname || cfg.wxocAccountId || ''}`
              : cfg.url
    this.adapter.secret = cfg.accessToken || null
    this.account = {
      uin: '',
      uid: '',
      selfId: '',
      name: '',
      avatar: '',
      subId: {},
    }
  }

  /** 幂等注册 */
  protected register () {
    if (this.adapter.index !== -1) return
    this.adapter.index = registerBot(this.adapter.communication, this)
  }

  /** 幂等注销 */
  protected unregister () {
    if (this.adapter.index === -1) return
    unregisterBot('index', this.adapter.index)
    this.adapter.index = -1
  }

  /** 断开底层连接并注销 (热更新/停用时调用) */
  async stop () {
    this.unregister()
    // 关闭底层连接: OneBot11WSClient / SnowLuma SDK 均有 close
    const raw: any = this.raw
    try { raw?.close?.() } catch { /* 忽略关闭异常 */ }
  }

  /** 启动并注册 */
  abstract start (): Promise<void>
}