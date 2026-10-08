'use client'

import * as AccordionPrimitive from '@radix-ui/react-accordion'
import { useState, type ReactNode } from 'react'
import { Trash2 } from 'lucide-react'
import { COMMUNICATIONS, EVENT_MODES, IMPLS, PROTOCOLS, fetchSignVersions, type BotForm } from '@/lib/api'
import { COMMUNICATION_TEXT, IMPL_TEXT, PROTOCOL_TEXT } from './protocol-meta'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { AccordionContent, AccordionItem } from '@/components/ui/accordion'
import LoginVerifyPanel from './login-verify'
import QqbotQrConnect, { type QrBindResult } from './qqbot-qr-connect'
import DouyinLogin, { type DouyinLoginResult } from './douyin-login'
import WxocQrConnect, { type WxocQrResult } from './wxoc-qr-connect'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { cn } from '@/lib/utils'

/* ===== 下拉选项定义 ===== */

const RECONNECT_OPTIONS = [
  { value: 'on', label: '自动重连' },
  { value: 'off', label: '关闭' },
]

const HEARTBEAT_OPTIONS = [
  { value: 'none', label: '默认' },
  { value: '10000', label: '10 秒' },
  { value: '30000', label: '30 秒' },
  { value: '60000', label: '1 分钟' },
  { value: '300000', label: '5 分钟' },
]

const TIMEOUT_OPTIONS = [
  { value: 'none', label: '默认' },
  { value: '5000', label: '5 秒' },
  { value: '10000', label: '10 秒' },
  { value: '15000', label: '15 秒' },
  { value: '30000', label: '30 秒' },
  { value: '60000', label: '1 分钟' },
]

/** milky 事件推送方式 */
const EVENT_MODE_OPTIONS = [
  { value: 'ws', label: 'WebSocket' },
  { value: 'sse', label: 'SSE' },
  { value: 'webhook', label: 'WebHook' },
]

/** icqq 登录方式 */
const LOGIN_TYPE_OPTIONS = [
  { value: 'fast', label: '快速登录 (已有 token)' },
  { value: 'password', label: '密码登录' },
  { value: 'qrcode', label: '扫码登录 (需 Watch 平台)' },
]

/** icqq Platform 枚举 */
const PLATFORM_OPTIONS = [
  { value: '1', label: 'Android (安卓)' },
  { value: '2', label: 'aPad (安卓平板)' },
  { value: '3', label: 'Watch (手表, 扫码用)' },
  { value: '4', label: 'iMac' },
  { value: '5', label: 'iPad' },
  { value: '6', label: 'Tim' },
  { value: '7', label: 'Custom' },
]

/** icqq 滑动验证方式 */
export const SLIDER_MODE_OPTIONS = [
  { value: 'gt', label: 'GT 网页验证' },
  { value: 'txhelper', label: 'txhelper 请求码' },
  { value: 'manual', label: '手动 ticket 文件' },
]

/** kook / qqbot 事件推送方式 (官方网关或 WebHook 回调) */
const WS_WEBHOOK_OPTIONS = [
  { value: 'ws', label: 'WebSocket' },
  { value: 'webhook', label: 'WebHook' },
]

interface Option { value: string; label: string }

/** 为选项列表补充当前自定义值, 保证已有配置可回显 */
const withCustom = (options: Option[], current: string): Option[] => {
  const raw = current.trim()
  if (!raw || options.some((o) => o.value === raw)) return options
  return [{ value: raw, label: `${raw} ms (自定义)` }, ...options]
}

/* ===== 基础组件 ===== */

function Field ({
  label, children, className, required, optional, hint, hidden,
}: {
  label: string
  children: ReactNode
  className?: string
  /** 必填字段, 渲染红色星号 */
  required?: boolean
  /** 选填字段, 渲染灰色「选填」标注 */
  optional?: boolean
  /** 字段下方的辅助说明 */
  hint?: ReactNode
  /** 不渲染该字段 */
  hidden?: boolean
}) {
  if (hidden) return null
  return (
    <div className={cn('space-y-1.5', className)}>
      <Label className='text-muted-foreground text-xs font-normal'>
        {label}
        {required && <span className='ml-0.5 text-red-500'>*</span>}
        {optional && <span className='ml-1 font-normal text-muted-foreground/60'>(选填)</span>}
      </Label>
      {children}
      {hint && <p className='text-xs leading-relaxed text-muted-foreground/70'>{hint}</p>}
    </div>
  )
}

function Dropdown ({
  value, onChange, options, disabled, placeholder,
}: {
  value: string
  onChange: (v: string) => void
  options: Option[]
  disabled?: boolean
  placeholder?: string
}) {
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <SelectTrigger>
        <SelectValue placeholder={placeholder ?? '请选择'} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** 消息正则替换区块 (kook / qqbot / douyin / wxoc 共用) */
function MsgReplaceSection ({ form, onChange }: { form: BotForm; onChange: (p: Partial<BotForm>) => void }) {
  return (
    <div className='space-y-1.5 @[26rem]:col-span-2'>
      <div className='flex items-center justify-between gap-2'>
        <Label className='text-muted-foreground text-xs font-normal'>
          消息正则替换
          <span className='ml-1 font-normal text-muted-foreground/60'>(选填)</span>
        </Label>
        <div className='flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground'>
          <span>{form.msgReplaceEnable ? '开启' : '关闭'}</span>
          <Switch
            checked={form.msgReplaceEnable}
            onCheckedChange={(v) => onChange({ msgReplaceEnable: v })}
            title='启用 / 禁用消息正则替换'
            aria-label='启用 / 禁用消息正则替换'
          />
        </div>
      </div>
      <textarea
        value={form.msgReplace}
        onChange={(e) => onChange({ msgReplace: e.target.value })}
        placeholder={'^\\s*/ #'}
        rows={3}
        spellCheck={false}
        className='border-input placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-ring/50 flex min-h-20 w-full rounded-md border bg-transparent px-3 py-2 font-mono text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:ring-[3px]'
      />
      <p className='text-xs leading-relaxed text-muted-foreground/70'>
        每行一条「正则 替换」
      </p>
    </div>
  )
}

/* ===== 布尔 / 哨兵值映射 ===== */

const boolValue = (b: boolean) => (b ? 'on' : 'off')
const toBool = (v: string) => v === 'on'
const toSentinel = (v: string) => (v.trim() ? v : 'none')
const fromSentinel = (v: string) => (v === 'none' ? '' : v)

/* ===== 正向 WS 地址 = IP + 端口 拆分 ===== */

/** 把 ws://host:port/ 拆成 { host, port } 便于独立配置 (正向 WS 服务端) */
const parseWsAddress = (raw: string): { host: string; port: string } => {
  const s = raw.trim()
  if (!s) return { host: '', port: '' }
  try {
    const u = /^\w+:\/\//.test(s) ? new URL(s) : new URL(`ws://${s.replace(/^\/+/, '')}`)
    return { host: u.hostname, port: u.port }
  } catch {
    return { host: '', port: '' }
  }
}

/** host 与 port 都填写时才合成监听地址 缺任一项视为未完成 (触发必填校验) */
const buildWsUrl = (host: string, port: string): string => {
  const h = host.trim()
  const p = port.trim()
  return h && p ? `ws://${h}:${p}/` : ''
}

/* ===== 手风琴连接卡片 ===== */

export interface BotCardProps {
  /** 手风琴项的 value, 由外层 Accordion 管理 */
  value: string
  index: number
  form: BotForm
  /** @icqqjs/icqq 是否已安装 (false 时 ICQQ 卡片展示安装引导, 后端也会拦截保存) */
  icqqAvailable: boolean
  onChange: (patch: Partial<BotForm>) => void
  onRemove: () => void
  /** qqbot 扫码绑定成功回调 (父组件用于自动保存并连接机器人) */
  onQrBound?: (v: QrBindResult) => void
  /** 抖音扫码登录成功 (回填后由页面立即保存触发热更新注册) */
  onDouyinBound?: (v: { douyinUid: string; douyinName: string }) => void
  /** wxoc 扫码登录成功 (回填后由页面立即保存触发热更新注册) */
  onWxocBound?: (v: { wxocToken: string; wxocAccountId: string; wxocUserId: string; wxocNickname: string; wxocBaseUrl: string }) => void
  /** true 时展示必填红框 (仅保存校验失败后由父组件置 true) */
  showErrors?: boolean
}

export default function BotCard ({ value, index, form, icqqAvailable, showErrors, onChange, onRemove, onQrBound, onDouyinBound, onWxocBound }: BotCardProps) {
  const patch = (p: Partial<BotForm>) => onChange(p)
  /** 签名服务 /ver 拉取的可用版本列表 (icqq 协议版本下拉) */
  const [signVersions, setSignVersions] = useState<string[]>([])
  const [verLoading, setVerLoading] = useState(false)
  const [verError, setVerError] = useState('')
  const loadSignVersions = async () => {
    setVerLoading(true)
    setVerError('')
    try {
      const { ver } = await fetchSignVersions(form.signApiAddr, form.uin)
      setSignVersions(ver)
    } catch (err) {
      setSignVersions([])
      setVerError(err instanceof Error ? err.message : String(err))
    } finally {
      setVerLoading(false)
    }
  }
  // 标题: 协议·实现组合 > 连接序号
  const protocolLabel = form.protocol ? (PROTOCOL_TEXT[form.protocol] ?? form.protocol) : ''
  const implLabel = form.protocol === 'onebot11' && form.impl ? (IMPL_TEXT[form.impl] ?? form.impl) : ''
  const autoTitle = [protocolLabel, implLabel].filter(Boolean).join(' · ')
  const title = autoTitle || `连接 ${index + 1}`
  const isIcqq = form.protocol === 'icqq'
  const isKook = form.protocol === 'kook'
  const isQqBot = form.protocol === 'qqbot'
  const isDouyin = form.protocol === 'douyin'
  const isWxoc = form.protocol === 'wxoc'
  /** 头部摘要: 收起时展示关键配置 (QQ 号 / Token / 连接地址), 展开后隐藏避免冗余 */
  const summary = isIcqq
    ? (form.uin.trim() ? `QQ ${form.uin.trim()}` : '未配置 QQ 号')
    : isKook
      ? (form.kookToken.trim() ? 'Token 已配置' : '未配置 Token')
      : isQqBot
        ? (form.qqbotAppId.trim() ? `AppID ${form.qqbotAppId.trim()}` : '未配置 AppID')
        : isDouyin
          ? (form.douyinUid.trim() ? (form.douyinName.trim() || `UID ${form.douyinUid.trim()}`) : '未扫码登录')
          : isWxoc
            ? (form.wxocToken.trim() ? 'Token 已配置' : '未扫码登录')
            : (form.url.trim() || '未配置连接地址')
  /** 协议直连(无 url): icqq / kook / qqbot / douyin / wxoc */
  const urlLess = isIcqq || isKook || isQqBot || isDouyin || isWxoc
  /** 必填校验: icqq 检查 QQ 号(扫码登录除外) / kook 检查 token / qqbot 检查 appid+token / douyin 检查 uid / wxoc 检查 token+机器人ID; 其余检查连接地址 */
  /** 必填缺失: 仅保存校验失败后 (showErrors) 标红提示 */
  const urlMissing = showErrors && form.enable && (isIcqq
    ? form.loginType !== 'qrcode' && !form.uin.trim()
    : isKook
      ? !form.kookToken.trim()
      : isQqBot
        ? !form.qqbotAppId.trim() || !form.qqbotClientSecret.trim()
        : isDouyin
          ? !form.douyinUid.trim()
          : isWxoc
            ? !form.wxocToken.trim() || !form.wxocAccountId.trim()
            : !form.url.trim())
  const isOneBot11 = form.protocol === 'onebot11'
  const isMilky = form.protocol === 'milky'
  const communication = isOneBot11 ? (form.communication || 'ws') : ''
  /** milky 事件推送方式 默认 ws */
  const eventMode = isMilky ? (form.eventMode || 'ws') : ''
  const isWs = communication === 'ws'
  const isWsReverse = communication === 'ws-reverse'
  const isHttp = communication === 'http'
  const isSse = communication === 'sse'
  /** 断线重连: 本端出站长连接才需要 (milky ws/sse、OneBot 反向 WS、OneBot SSE); 正向 WS 与 HTTP、milky webhook 为常驻服务无重连概念 */
  const showReconnect = isMilky ? eventMode !== 'webhook' : (isWsReverse || isSse)
  const showHeartbeat = isMilky ? eventMode === 'ws' : isWsReverse
  /** 请求超时: 仅 OneBot 消费该字段(后端 milky 固定 axios 无超时配置) */
  const showTimeout = isOneBot11
  /** url 标签随通信方式变化 正向=本端服务端监听 反向=本端客户端连接 */
  const URL_LABEL = {
    ws: '本端监听 (正向 WS)',
    'ws-reverse': '协议端地址 (反向 WS)',
    http: '协议端 API 地址 (HTTP)',
    sse: '协议端 API 地址 (HTTP SSE)',
  } as Record<string, string>
  const urlLabel = isOneBot11
    ? (URL_LABEL[communication] ?? URL_LABEL.ws)
    : (isMilky ? '协议端地址 (milky)' : '连接地址')
  const urlPlaceholder = isMilky ? 'http://127.0.0.1:8000' : (isHttp || isSse ? 'http://127.0.0.1:3000' : 'ws://127.0.0.1:3001/')
  /** 正向 WS: 拆为 监听IP + 监听端口 两个输入框 */
  const wsAddr = isWs ? parseWsAddress(form.url) : null
  /** URL 提示 随模式变化 */
  const URL_HINT = {
    ws: '协议端连入此地址',
    'ws-reverse': '本端连接的协议端地址',
    http: '协议端 API 地址',
    sse: '协议端 API 地址',
    milky: 'milky 协议端地址',
  } as Record<string, string>
  const urlHint = isOneBot11
    ? (URL_HINT[communication] ?? URL_HINT.ws)
    : (isMilky ? URL_HINT.milky : '')
  /** eventUrl 的语义: OneBot HTTP/SSE 为协议端事件地址, milky webhook 为本端监听地址 */
  const showEventUrl = isHttp || isSse || isMilky && eventMode === 'webhook'
  const eventUrlLabel = isMilky ? 'WebHook 监听地址' : (isHttp ? '事件上报地址 (协议端 POST)' : '事件流地址 (协议端 SSE)')
  const eventUrlHint = isMilky
    ? '如 0.0.0.0:8088'
    : (isHttp
      ? '协议端事件上报地址'
      : '协议端 SSE 事件流地址')
  /** Token 在各模式下的作用不同 */
  const TOKEN_HINT = {
    ws: '协议端连入时携带',
    'ws-reverse': '与协议端一致',
    http: '调用 API 时携带',
    sse: '调用 API 时携带',
    milky: '与协议端一致',
    'milky-webhook': '与协议端一致',
  } as Record<string, string>
  const tokenHint = isOneBot11
    ? (TOKEN_HINT[communication] ?? TOKEN_HINT.ws)
    : (isMilky ? (eventMode === 'webhook' ? TOKEN_HINT['milky-webhook'] : TOKEN_HINT.milky) : '')
  const tokenPlaceholder = isWs
    ? '协议端连接须携带'
    : '与协议端一致'

  return (
    <AccordionItem
      value={value}
      className='@container overflow-hidden rounded-xl border bg-card shadow-sm data-[state=open]:col-span-full'
    >
      {/* 头部: 点击展开 / 收起, 摘要仅收起时可见, 右侧为启用开关与删除 */}
      <AccordionPrimitive.Header className='flex min-w-0 items-center border-b border-border/60'>
        <AccordionPrimitive.Trigger className='group flex min-w-0 flex-1 items-center gap-2.5 py-3 pl-4 text-sm font-medium transition-colors select-none hover:bg-accent/50 [&[data-state=open]>svg]:rotate-180'>
          <span
            className={cn(
              'h-2 w-2 shrink-0 rounded-full',
              urlMissing ? 'bg-red-500' : form.enable ? 'bg-emerald-500' : 'bg-muted-foreground/50',
            )}
            title={urlMissing
              ? (isIcqq
                ? '缺少必填的 QQ 号'
                : isKook
                  ? '缺少必填的 Kook Token'
                  : isQqBot
                    ? '缺少必填的 AppID / Token'
                    : isDouyin
                      ? '缺少必填的抖音 UID'
                      : isWxoc
                        ? '缺少必填的 Token / 机器人 ID'
                        : '缺少必填的连接地址')
              : form.enable ? '已启用' : '已停用'}
          />
          <span className='truncate'>{title}</span>
          <span className='hidden min-w-0 truncate text-xs font-normal text-muted-foreground group-data-[state=open]:hidden @[34rem]:inline'>
            · {summary}
          </span>
        </AccordionPrimitive.Trigger>
        <div className='flex shrink-0 items-center gap-0.5 pr-2.5'>
          {isQqBot && (
            <QqbotQrConnect
              onBound={(v) => {
                patch({ qqbotAppId: v.appId, qqbotClientSecret: v.appSecret })
                onQrBound?.(v)
              }}
            />
          )}
          {isDouyin && (
            <DouyinLogin
              onBound={(v: DouyinLoginResult) => {
                patch({ douyinUid: v.uid, douyinName: v.name || form.douyinName })
                onDouyinBound?.({ douyinUid: v.uid, douyinName: v.name || form.douyinName })
              }}
            />
          )}
          {isWxoc && (
            <WxocQrConnect
              onBound={(v: WxocQrResult) => {
                const wxoc = {
                  wxocToken: v.token,
                  wxocAccountId: v.accountId,
                  wxocUserId: v.userId,
                  wxocNickname: v.nickname,
                  wxocBaseUrl: v.baseUrl,
                }
                patch(wxoc)
                onWxocBound?.(wxoc)
              }}
            />
          )}
          <Switch
            checked={form.enable}
            onCheckedChange={(v) => patch({ enable: v })}
            title={form.enable ? '停用该连接' : '启用该连接'}
            aria-label={form.enable ? '停用该连接' : '启用该连接'}
          />
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant='ghost'
                size='sm'
                className='px-2 text-destructive hover:text-destructive'
                title='删除该连接'
              >
                <Trash2 className='size-4' />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>删除该连接?</AlertDialogTitle>
                <AlertDialogDescription>
                  删除后需点击「保存配置」才会真正生效。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction className='bg-destructive text-white hover:bg-destructive/90' onClick={onRemove}>
                  删除
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </AccordionPrimitive.Header>

      <AccordionContent className='px-4 pt-4'>
        {isIcqq && !icqqAvailable && (
          <div className='mb-4 flex flex-col gap-1.5 rounded-lg border border-amber-300/70 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200'>
            <p className='font-medium'>需安装 icqq (@icqqjs/icqq)，未安装时无法保存。</p>
            <p className='font-mono break-all' dir='ltr'>
              pnpm add icqq@npm:@icqqjs/icqq -w
            </p>
            <p>装好后回到本页保存即生效，无需重启。</p>
          </div>
        )}
        <div className='grid grid-cols-1 gap-x-4 gap-y-4 @[26rem]:grid-cols-2'>
          <Field label='协议' required>
            <Dropdown
              value={form.protocol}
              onChange={(v) => patch({ protocol: v })}
              options={PROTOCOLS.map((p) => ({ value: p, label: PROTOCOL_TEXT[p] ?? p }))}
            />
          </Field>
          <Field label={form.protocol === 'onebot11' ? '实现' : '实现 (仅 OneBot 11)'} required>
            <Dropdown
              value={form.impl}
              onChange={(v) => patch({ impl: v })}
              options={IMPLS.map((i) => ({ value: i, label: IMPL_TEXT[i] ?? i }))}
              disabled={form.protocol !== 'onebot11'}
            />
          </Field>
          {form.protocol === 'onebot11' && (
            <Field label='通信方式' required>
              <Dropdown
                value={communication}
                onChange={(v) => patch({ communication: v })}
                options={COMMUNICATIONS.map((c) => ({ value: c, label: COMMUNICATION_TEXT[c] ?? c }))}
              />
            </Field>
          )}
          {isMilky && (
            <Field label='事件推送方式' required hint={eventMode === 'webhook' ? '需填下方监听地址' : undefined}>
              <Dropdown
                value={eventMode}
                onChange={(v) => patch({ eventMode: v })}
                options={EVENT_MODES.map((m) => ({ value: m, label: EVENT_MODE_OPTIONS.find((o) => o.value === m)?.label ?? m }))}
              />
            </Field>
          )}
          <Field label='断线重连' hidden={!showReconnect}>
            <Dropdown value={boolValue(form.reconnect)} onChange={(v) => patch({ reconnect: toBool(v) })} options={RECONNECT_OPTIONS} />
          </Field>
          <Field label='心跳间隔' hidden={!showHeartbeat}>
            <Dropdown
              value={toSentinel(form.heartbeatInterval)}
              onChange={(v) => patch({ heartbeatInterval: fromSentinel(v) })}
              options={withCustom(HEARTBEAT_OPTIONS, form.heartbeatInterval)}
            />
          </Field>
          <Field label='请求超时' hidden={!showTimeout}>
            <Dropdown
              value={toSentinel(form.requestTimeout)}
              onChange={(v) => patch({ requestTimeout: fromSentinel(v) })}
              options={withCustom(TIMEOUT_OPTIONS, form.requestTimeout)}
            />
          </Field>
          {!urlLess && (
            <>
              {isWs ? (
                <Field label={urlLabel} required className='@[26rem]:col-span-2' hint={urlHint}>
                  <div className='flex flex-wrap items-center gap-2'>
                    <span className='font-mono text-sm text-muted-foreground/80'>ws://</span>
                    <Input
                      value={wsAddr?.host ?? ''}
                      placeholder='0.0.0.0'
                      aria-label='监听 IP'
                      className={cn('flex-1 min-w-[8rem]', showErrors && !form.url.trim() && 'border-destructive focus-visible:ring-destructive')}
                      onChange={(e) => patch({ url: buildWsUrl(e.target.value, wsAddr?.port ?? '') })}
                    />
                    <span className='font-mono text-sm text-muted-foreground/80'>:</span>
                    <Input
                      value={wsAddr?.port ?? ''}
                      placeholder='8082'
                      aria-label='监听端口'
                      inputMode='numeric'
                      className={cn('w-28', showErrors && !form.url.trim() && 'border-destructive focus-visible:ring-destructive')}
                      onChange={(e) => patch({ url: buildWsUrl(wsAddr?.host ?? '', e.target.value) })}
                    />
                  </div>
                </Field>
              ) : (
                <Field label={urlLabel} required className='@[26rem]:col-span-2' hint={urlHint}>
                  <Input
                    value={form.url}
                    placeholder={urlPlaceholder}
                    className={cn(showErrors && !form.url.trim() && 'border-destructive focus-visible:ring-destructive')}
                    onChange={(e) => patch({ url: e.target.value })}
                  />
                </Field>
              )}
            </>
          )}
          {showEventUrl && (
            <Field label={eventUrlLabel} required className='@[26rem]:col-span-2' hint={eventUrlHint}>
              <Input
                value={form.eventUrl}
                placeholder={isMilky ? '0.0.0.0:8088' : isHttp ? 'http://0.0.0.0:8090/' : 'http://127.0.0.1:3000/events'}
                className={cn(showErrors && form.enable && !form.eventUrl.trim() && 'border-destructive focus-visible:ring-destructive')}
                onChange={(e) => patch({ eventUrl: e.target.value })}
              />
            </Field>
          )}
          <Field label='鉴权 Token' optional hidden={urlLess} hint={tokenHint}>
            <Input
              type='password'
              value={form.accessToken}
              placeholder={tokenPlaceholder}
              onChange={(e) => patch({ accessToken: e.target.value })}
            />
          </Field>
          {isIcqq && (
            <>
              <Field
                label='QQ 号'
                required={form.loginType !== 'qrcode'}
                hint='扫码登录可不填'
              >
                <Input
                  value={form.uin}
                  placeholder='10001'
                  inputMode='numeric'
                  className={cn(showErrors && form.enable && form.loginType !== 'qrcode' && !form.uin.trim() && 'border-destructive focus-visible:ring-destructive')}
                  onChange={(e) => patch({ uin: e.target.value })}
                />
              </Field>
              <Field label='登录方式' required>
                <Dropdown
                  value={form.loginType}
                  onChange={(v) => patch({ loginType: v })}
                  options={LOGIN_TYPE_OPTIONS}
                />
              </Field>
              {form.loginType === 'password' && (
                <Field label='密码' required hint='首次登录后自动保存'>
                  <Input
                    type='password'
                    value={form.password}
                    placeholder='QQ 密码'
                    onChange={(e) => patch({ password: e.target.value })}
                  />
                </Field>
              )}
              <Field
                label='协议平台'
                optional
                hint={form.loginType === 'qrcode' ? '扫码登录须使用 Watch (3)' : '默认 Android (1)'}
              >
                <Dropdown
                  value={form.platform || '1'}
                  onChange={(v) => patch({ platform: v })}
                  options={PLATFORM_OPTIONS}
                />
              </Field>
              <Field
                label='协议版本'
                optional
                hint={verError || (signVersions.length
                  ? `共 ${signVersions.length} 个版本`
                  : '拉取可选版本')}
              >
                <div className='flex gap-2'>
                  {signVersions.length > 0 ? (
                    <Dropdown
                      value={signVersions.includes(form.ver) ? form.ver : ''}
                      onChange={(v) => patch({ ver: v })}
                      options={signVersions.map((v) => ({ value: v, label: v }))}
                      placeholder='选择版本'
                    />
                  ) : (
                    <Input
                      value={form.ver}
                      placeholder='9.1.70'
                      onChange={(e) => patch({ ver: e.target.value })}
                    />
                  )}
                  <Button
                    type='button'
                    variant='outline'
                    size='sm'
                    className='shrink-0 px-3'
                    disabled={!form.signApiAddr.trim() || verLoading}
                    onClick={loadSignVersions}
                  >
                    {verLoading ? '获取中…' : '获取版本'}
                  </Button>
                </div>
              </Field>
              <Field label='签名服务地址' optional hint='留空用库默认'>
                <Input
                  value={form.signApiAddr}
                  placeholder='http://127.0.0.1:8080/'
                  onChange={(e) => patch({ signApiAddr: e.target.value })}
                />
              </Field>
              <Field label='滑块验证方式' optional>
                <Dropdown
                  value={form.sliderMode || 'gt'}
                  onChange={(v) => patch({ sliderMode: v })}
                  options={SLIDER_MODE_OPTIONS}
                />
              </Field>
              <div className='@[26rem]:col-span-2'>
                <LoginVerifyPanel uin={form.uin} />
              </div>
            </>
          )}
          {isKook && (
            <>
              <Field label='事件推送方式' required hint={form.kookEventMode === 'webhook' ? '需填下方监听地址' : undefined}>
                <Dropdown
                  value={form.kookEventMode || 'ws'}
                  onChange={(v) => patch({ kookEventMode: v })}
                  options={WS_WEBHOOK_OPTIONS}
                />
              </Field>
              <Field label='Bot Token' required hint='Kook 机器人 Token'>
                <Input
                  type='password'
                  value={form.kookToken}
                  placeholder='1/MjE4Nxxxx'
                  className={cn(showErrors && form.enable && !form.kookToken.trim() && 'border-destructive focus-visible:ring-destructive')}
                  onChange={(e) => patch({ kookToken: e.target.value })}
                />
              </Field>
              {form.kookEventMode === 'webhook' && (
                <Field label='WebHook 监听地址' required hint='如 0.0.0.0:8091'>
                  <Input
                    value={form.kookWebhookUrl}
                    placeholder='0.0.0.0:8091'
                    className={cn(showErrors && form.enable && !form.kookWebhookUrl.trim() && 'border-destructive focus-visible:ring-destructive')}
                    onChange={(e) => patch({ kookWebhookUrl: e.target.value })}
                  />
                </Field>
              )}
              <MsgReplaceSection form={form} onChange={patch} />
            </>
          )}
          {isQqBot && (
            <>
              <Field label='事件推送方式' required hint={form.qqbotEventMode === 'webhook' ? '需填下方监听地址' : undefined}>
                <Dropdown
                  value={form.qqbotEventMode || 'ws'}
                  onChange={(v) => patch({ qqbotEventMode: v })}
                  options={WS_WEBHOOK_OPTIONS}
                />
              </Field>
              <Field label='AppID' required hint='开放平台后台获取'>
                <Input
                  value={form.qqbotAppId}
                  placeholder='1020xxxx'
                  className={cn(showErrors && form.enable && !form.qqbotAppId.trim() && 'border-destructive focus-visible:ring-destructive')}
                  onChange={(e) => patch({ qqbotAppId: e.target.value })}
                />
              </Field>
              <Field label='App Secret' required hint='开放平台后台获取'>
                <Input
                  type='password'
                  value={form.qqbotClientSecret}
                  placeholder='xxxxxxxx'
                  className={cn(showErrors && form.enable && !form.qqbotClientSecret.trim() && 'border-destructive focus-visible:ring-destructive')}
                  onChange={(e) => patch({ qqbotClientSecret: e.target.value })}
                />
              </Field>
              {form.qqbotEventMode === 'webhook' && (
                <Field label='WebHook 监听地址' required hint='如 0.0.0.0:8092'>
                  <Input
                    value={form.qqbotWebhookUrl}
                    placeholder='0.0.0.0:8092'
                    className={cn(showErrors && form.enable && !form.qqbotWebhookUrl.trim() && 'border-destructive focus-visible:ring-destructive')}
                    onChange={(e) => patch({ qqbotWebhookUrl: e.target.value })}
                  />
                </Field>
              )}
              <MsgReplaceSection form={form} onChange={patch} />
            </>
          )}
          {isDouyin && (
            <>
              <Field label='抖音 UID' required className='@[26rem]:col-span-2' hint='右上角扫码登录后自动回填'>
                <Input
                  value={form.douyinUid}
                  placeholder='扫码登录后自动获取'
                  readOnly
                  className={cn('min-w-0', showErrors && form.enable && !form.douyinUid.trim() && 'border-destructive focus-visible:ring-destructive')}
                />
              </Field>
              <Field label='账号昵称' optional hint='备注用 可留空'>
                <Input
                  value={form.douyinName}
                  placeholder='扫码登录后自动回填'
                  onChange={(e) => patch({ douyinName: e.target.value })}
                />
              </Field>
              <MsgReplaceSection form={form} onChange={patch} />
            </>
          )}
          {isWxoc && (
            <>
              <Field label='登录凭证 Token' required className='@[26rem]:col-span-2' hint='右上角扫码登录后自动回填'>
                <Input
                  type='password'
                  value={form.wxocToken}
                  placeholder='扫码登录后自动获取'
                  className={cn('min-w-0', showErrors && form.enable && !form.wxocToken.trim() && 'border-destructive focus-visible:ring-destructive')}
                  onChange={(e) => patch({ wxocToken: e.target.value })}
                />
              </Field>
              <Field label='机器人 ID' required hint='ilink 机器人 ID 扫码后自动回填'>
                <Input
                  value={form.wxocAccountId}
                  placeholder='扫码登录后自动获取'
                  className={cn(showErrors && form.enable && !form.wxocAccountId.trim() && 'border-destructive focus-visible:ring-destructive')}
                  onChange={(e) => patch({ wxocAccountId: e.target.value })}
                />
              </Field>
              <Field label='用户 ID' optional hint='ilink 用户 ID 扫码后自动回填'>
                <Input
                  value={form.wxocUserId}
                  placeholder='扫码登录后自动获取'
                  onChange={(e) => patch({ wxocUserId: e.target.value })}
                />
              </Field>
              <Field label='昵称' optional>
                <Input
                  value={form.wxocNickname}
                  placeholder='扫码登录后自动回填'
                  onChange={(e) => patch({ wxocNickname: e.target.value })}
                />
              </Field>
              <Field label='API 地址' optional hint='登录返回的服务地址 留空用默认'>
                <Input
                  value={form.wxocBaseUrl}
                  placeholder='扫码登录后自动回填'
                  onChange={(e) => patch({ wxocBaseUrl: e.target.value })}
                />
              </Field>
              <MsgReplaceSection form={form} onChange={patch} />
            </>
          )}
        </div>
      </AccordionContent>
    </AccordionItem>
  )
}