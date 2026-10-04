'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, QrCode, RefreshCw, X } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { resolveHost } from '@/lib/api'

/** 后端扫码绑定 API 前缀 与 src/server.ts 保持一致 */
const QR_API_BASE = `${resolveHost()}/adapter-all/api/qqbot/qr`

/** 扫码绑定成功的凭证 由父组件回填表单 */
export interface QrBindResult {
  appId: string
  appSecret: string
  userOpenid?: string
}

/**
 * QQ开放平台「扫码绑定」面板 (qqbot bot 卡片内):
 * 调后端 /start 生成二维码 → 手机 QQ 扫码确认 → 2s 轮询 /status → 成功后回调 onBound
 * 由父组件把 AppID / AppSecret 回填当前卡片表单, 用户保存后生效。
 */
export default function QqbotQrConnect ({ onBound }: { onBound: (v: QrBindResult) => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [image, setImage] = useState('')
  const [sid, setSid] = useState('')
  const [phase, setPhase] = useState<'idle' | 'pending' | 'scanned' | 'expired'>('idle')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onBoundRef = useRef(onBound)
  onBoundRef.current = onBound

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  /** 轮询一次扫码状态 失败停止轮询避免刷屏 */
  const poll = async (id: string) => {
    try {
      const res = await fetch(`${QR_API_BASE}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid: id }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.code === 500) throw new Error(json?.message ?? `HTTP ${res.status}`)
      const d = json?.data ?? {}
      if (d.phase === 'scanned') {
        stopPolling()
        setPhase('scanned')
        onBoundRef.current({
          appId: String(d.appId ?? ''),
          appSecret: String(d.appSecret ?? ''),
          userOpenid: d.userOpenid,
        })
      } else if (d.phase === 'expired') {
        stopPolling()
        setPhase('expired')
      }
    } catch (err) {
      stopPolling()
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 创建扫码会话并开始轮询 */
  const start = async () => {
    setBusy(true)
    setError('')
    setPhase('idle')
    setImage('')
    try {
      const res = await fetch(`${QR_API_BASE}/start`, { method: 'POST' })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.code === 500) throw new Error(json?.message ?? `HTTP ${res.status}`)
      const data = json?.data ?? {}
      if (!data.id || !data.image) throw new Error('扫码任务创建失败: 响应缺少二维码')
      setSid(String(data.id))
      setImage(String(data.image))
      setPhase('pending')
      timerRef.current = setInterval(() => { void poll(String(data.id)) }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** 关闭面板 取消后台轮询与会话 */
  const close = () => {
    stopPolling()
    if (sid) {
      fetch(`${QR_API_BASE}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sid }),
      }).catch(() => { /* 取消失败无需处理 */ })
    }
    setOpen(false)
  }

  // 组件卸载时清理轮询
  useEffect(() => () => stopPolling(), [stopPolling])

  return (
    <div className='space-y-2'>
      <Button size='sm' variant='outline' className='gap-1.5' onClick={() => setOpen((v) => !v)}>
        <QrCode className='size-3.5' />
        扫码绑定
      </Button>
      {open && (
        <div className='space-y-2.5 rounded-lg border bg-muted/30 p-3'>
          {(!image || phase === 'idle') && (
            <div className='flex flex-wrap items-center justify-between gap-2'>
              <span className='text-xs leading-relaxed text-muted-foreground'>
                无需手动填写凭证，手机 QQ 扫码后自动获取 AppID / AppSecret 并回填表单
              </span>
              <Button size='sm' onClick={start} disabled={busy}>
                {busy ? '生成中...' : '生成二维码'}
              </Button>
            </div>
          )}
          {image && phase === 'pending' && (
            <div className='space-y-2'>
              <div className='flex items-center justify-between gap-2'>
                <Badge variant='outline' className='bg-amber-500/15 text-amber-600 dark:text-amber-400'>
                  等待扫码
                </Badge>
                <Button size='sm' variant='ghost' className='gap-1 text-muted-foreground' onClick={close}>
                  <X className='size-3.5' /> 取消
                </Button>
              </div>
              <img
                src={image}
                alt='QQBot 扫码绑定二维码'
                className='mx-auto size-56 rounded-md border bg-background p-2'
              />
              <p className='text-center text-xs leading-relaxed text-muted-foreground'>
                请使用手机 QQ「扫一扫」扫码并确认绑定
              </p>
            </div>
          )}
          {phase === 'scanned' && (
            <div className='space-y-2'>
              <div className='flex items-center gap-2'>
                <CheckCircle2 className='size-4 text-emerald-500' />
                <Badge className='bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'>绑定成功</Badge>
              </div>
              <p className='text-xs leading-relaxed text-muted-foreground'>
                已获取 AppID / AppSecret，配置已自动保存并开始连接机器人，无需手动操作。
              </p>
              <Button size='sm' variant='outline' onClick={() => setOpen(false)}>完成</Button>
            </div>
          )}
          {phase === 'expired' && (
            <div className='space-y-2'>
              <Badge variant='outline' className='text-red-600 dark:text-red-400'>二维码已过期</Badge>
              <Button size='sm' className='gap-1.5' onClick={start} disabled={busy}>
                <RefreshCw className='size-3.5' /> 重新生成
              </Button>
            </div>
          )}
          {error && <p className='text-xs leading-relaxed text-red-500'>{error}</p>}
        </div>
      )}
    </div>
  )
}