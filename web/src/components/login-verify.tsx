'use client'

import { useState } from 'react'
import { ExternalLink, RefreshCw, Send, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import { authHeaders } from '@/lib/api'
import { useLoginState, type LoginPhase } from '@/lib/login-events'

/** 后端登录验证 API 前缀 与 src/server.ts 保持一致 */
const LOGIN_API_BASE = '/adapter-all/api/login'

/** 各登录阶段的状态徽章文案与配色 */
const PHASE_META: Record<LoginPhase, { label: string; className: string }> = {
  idle: { label: '空闲', className: 'bg-muted text-muted-foreground' },
  slider: { label: '待滑动验证', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  auth: { label: '待登录验证', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  device: { label: '设备锁验证', className: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
  submitting: { label: '验证通过, 正在登录...', className: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  relogin: { label: '验证通过, 重新登录中', className: 'bg-sky-500/15 text-sky-600 dark:text-sky-400' },
  online: { label: '已登录', className: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
  failed: { label: '登录失败', className: 'bg-red-500/15 text-red-600 dark:text-red-400' },
}

const fmtTime = (t: number) =>
  new Date(t).toLocaleTimeString('zh-CN', { hour12: false })

/** 手机号脱敏显示: 138****5678 (非 11 位原样返回) */
const maskPhone = (phone: string) =>
  /^\d{11}$/.test(phone) ? `${phone.slice(0, 3)}****${phone.slice(7)}` : phone

/**
 * 登录验证面板 (仅 icqq, 在 bot 卡片内展示):
 * 显示当前登录验证阶段徽章、验证链接(新窗口打开)与最近事件时间线。
 * 腾讯/CapNT/Auth 验证页均禁止第三方 iframe 嵌入, 因此用新窗口打开。
 */
export default function LoginVerifyPanel ({ uin }: { uin: string }) {
  const state = useLoginState(uin)
  const [embed, setEmbed] = useState(false)
  /** 短信验证码 (设备锁) */
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'send' | 'submit' | 'retry' | null>(null)
  const [smsMsg, setSmsMsg] = useState<string | null>(null)

  /** 发送 / 提交短信验证码 (老协议设备锁) 或 网页验证完成后手动续登 (NT/老协议通用) */
  const sms = async (action: 'send' | 'submit' | 'retry') => {
    if (!state) return
    setBusy(action)
    setSmsMsg(null)
    try {
      const res = await fetch(`${LOGIN_API_BASE}/sms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ uin: state.uin, action, code: action === 'submit' ? code : undefined }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.code === 500) throw new Error(json?.message ?? `HTTP ${res.status}`)
      setSmsMsg(json?.message ?? (action === 'send' ? '验证码已发送' : action === 'submit' ? '验证码已提交' : '已触发重新登录'))
      if (action === 'submit') setCode('')
    } catch (err) {
      setSmsMsg(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }

  const key = String(uin ?? '').trim()
  if (!key || !state || state.events.length === 0) return null
  const meta = PHASE_META[state.phase] ?? PHASE_META.idle
  const list = [...state.events].reverse().slice(0, 6)

  return (
    <div className='space-y-2 rounded-lg border bg-muted/30 p-3'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex items-center gap-2'>
          <Badge variant='outline' className={cn('text-xs', meta.className)}>
            {meta.label}
          </Badge>
          <span className='text-xs text-muted-foreground'>登录验证</span>
        </div>
        <div className='flex items-center gap-2'>
          {state.url && (state.phase === 'slider' || state.phase === 'auth') && (
            <>
              <Button
                size='sm'
                variant={embed ? 'outline' : 'default'}
                className='gap-1.5'
                onClick={() => setEmbed((v) => !v)}
              >
                {embed ? '收起' : '内嵌显示'}
              </Button>
              <Button
                size='sm'
                variant='outline'
                className='gap-1.5'
                onClick={() => window.open(state.url, '_blank', 'noopener,noreferrer')}
              >
                <ExternalLink className='size-3.5' />
                新窗口打开
              </Button>
            </>
          )}
        </div>
      </div>
      {state.url && embed && (state.phase === 'slider' || state.phase === 'auth') && (
        <div className='space-y-1.5'>
          <div className='overflow-hidden rounded-md border bg-background'>
            <iframe
              key={state.url}
              src={state.url}
              title={`登录验证链接 (${state.uin})`}
              className='h-96 w-full'
            />
          </div>
          <p className='text-xs leading-relaxed text-muted-foreground/70'>
            若内嵌页面显示空白或「拒绝连接」，说明该验证站点禁止内嵌，请点击「新窗口打开」完成验证。
          </p>
        </div>
      )}
      {state.phase === 'device' && (
        <div className='space-y-2 rounded-md border bg-background/60 p-3'>
          <div className='flex items-center gap-1.5 text-xs font-medium text-foreground/85'>
            <ShieldCheck className='size-3.5 text-amber-500' />
            设备锁验证 · 新设备保护
          </div>
          {state.phone ? (
            <>
              <p className='text-xs leading-relaxed text-muted-foreground/70'>
                密保手机 <span className='font-medium text-foreground/80'>{maskPhone(state.phone)}</span>:
                可直接发送/提交短信验证码, 无需打开网页。
              </p>
              <div className='flex flex-wrap items-center gap-2'>
                <Button size='sm' variant='outline' disabled={busy !== null} onClick={() => sms('send')}>
                  <Send className='size-3.5' />
                  {busy === 'send' ? '发送中...' : '发送验证码'}
                </Button>
                <Input
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder='6 位验证码'
                  inputMode='numeric'
                  maxLength={6}
                  className='w-32'
                  disabled={busy !== null}
                />
                <Button size='sm' disabled={!code.trim() || busy !== null} onClick={() => sms('submit')}>
                  {busy === 'submit' ? '提交中...' : '提交验证码'}
                </Button>
              </div>
            </>
          ) : (
            <>
              <p className='text-xs leading-relaxed text-muted-foreground/70'>
                无可用密保手机号, 请使用绑定的手机 QQ 扫码或确认完成:
              </p>
              {state.url && (
                <a
                  href={state.url}
                  target='_blank'
                  rel='noopener noreferrer'
                  className='inline-flex max-w-full items-start gap-1.5 break-all text-xs leading-relaxed text-sky-600 underline underline-offset-2 hover:text-sky-500 dark:text-sky-400'
                >
                  <ExternalLink className='mt-px size-3.5 shrink-0' />
                  <span className='min-w-0'>{state.url}</span>
                </a>
              )}
            </>
          )}
          {/* icqq 设备锁无自动回调: 验证完成后必须手动重新登录 */}
          <div className='flex flex-wrap items-center gap-2 pt-1'>
            <Button
              size='sm'
              variant='outline'
              disabled={busy !== null}
              onClick={() => sms('retry')}
            >
              <RefreshCw className={cn('size-3.5', busy === 'retry' && 'animate-spin')} />
              {busy === 'retry' ? '重新登录中...' : '我已验证完成, 继续登录'}
            </Button>
            {smsMsg && (
              <span className={cn('text-xs', /失败|错误/.test(smsMsg) ? 'text-red-500' : 'text-muted-foreground')}>
                {smsMsg}
              </span>
            )}
          </div>
        </div>
      )}
      <ul className='space-y-1'>
        {list.map((ev, i) => (
          <li key={`${ev.time}-${i}`} className='flex items-baseline gap-2 text-xs leading-relaxed'>
            <span className='shrink-0 tabular-nums text-muted-foreground/60'>{fmtTime(ev.time)}</span>
            <span className='text-foreground/85'>{ev.title}</span>
            {ev.message && <span className='min-w-0 truncate text-muted-foreground'>{ev.message}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}