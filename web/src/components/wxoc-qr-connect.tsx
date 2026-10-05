'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, QrCode, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { authHeaders, wxocQrCancel, wxocQrStart, wxocQrStatus } from '@/lib/api'

/** 扫码登录成功后回填给父组件的凭据 */
export interface WxocQrResult {
  token: string
  accountId: string
  userId: string
  nickname: string
  baseUrl: string
}

type Phase = 'idle' | 'pending' | 'expired' | 'connecting' | 'online'

/**
 * 微信 Claw (wxoc)「扫码登录」: 表单内入口按钮 + 居中模态弹窗。
 * 打开即创建扫码任务展示二维码 → 2s 轮询状态 → 扫码成功后回填
 * token / 机器人 ID / 用户 ID / 昵称 / API 地址并自动关闭, 关闭时取消会话。
 */
export default function WxocQrConnect ({ onBound }: { onBound: (v: WxocQrResult) => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [image, setImage] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const sidRef = useRef('')
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const onBoundRef = useRef(onBound)
  onBoundRef.current = onBound

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  /** 关闭弹窗 取消后台轮询与扫码任务 */
  const close = useCallback(() => {
    stopPolling()
    if (sidRef.current) {
      wxocQrCancel(sidRef.current).catch(() => { /* 取消失败无需处理 */ })
      sidRef.current = ''
    }
    setOpen(false)
  }, [stopPolling])

  /** 轮询一次扫码状态 失败停止轮询避免刷屏 */
  const poll = async (sid: string) => {
    try {
      const res = await wxocQrStatus(sid)
      if (!res.success) throw new Error(res.message ?? '扫码状态查询失败')
      const d = res.data
      if (!d) return
      if (d.phase === 'scanned') {
        // 扫码成功 → 回填凭据, 转入「连接中」阶段, 轮询 bot 连接状态 (会话已完成 无需取消)
        stopPolling()
        const accountId = String(d.accountId ?? '')
        sidRef.current = ''
        onBoundRef.current({
          token: String(d.token ?? ''),
          accountId,
          userId: String(d.userId ?? ''),
          nickname: String(d.nickname ?? ''),
          baseUrl: String(d.baseUrl ?? ''),
        })
        setPhase('connecting')
        timerRef.current = setInterval(() => { void pollConnected(accountId) }, 2000)
      } else if (d.phase === 'expired') {
        stopPolling()
        setPhase('expired')
      }
    } catch (err) {
      stopPolling()
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 轮询 bot 连接状态 连上后进入「登录成功」并自动关闭 */
  const pollConnected = async (accountId: string) => {
    try {
      const res = await fetch(`/adapter-all/api/wxoc/qr/connected?accountId=${encodeURIComponent(accountId)}`, { headers: authHeaders() })
      const json = await res.json().catch(() => ({}))
      if (!res.ok || json?.code === 500) throw new Error(json?.message ?? `HTTP ${res.status}`)
      if (json?.data?.connected) {
        stopPolling()
        setPhase('online')
        setTimeout(close, 1200)
      }
    } catch (err) {
      stopPolling()
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 创建扫码任务并开始轮询 */
  const start = async () => {
    stopPolling()
    setBusy(true)
    setError('')
    setPhase('idle')
    setImage('')
    try {
      const res = await wxocQrStart()
      if (!res.success || !res.data?.id || !res.data?.image) throw new Error(res.message ?? '扫码任务创建失败: 响应缺少二维码')
      sidRef.current = res.data.id
      setImage(res.data.image)
      setPhase('pending')
      timerRef.current = setInterval(() => { void poll(sidRef.current) }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // 打开弹窗即自动生成二维码
  useEffect(() => {
    if (open) void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 组件卸载时清理轮询
  useEffect(() => () => stopPolling(), [stopPolling])

  return (
    <>
      <Button
        variant='ghost'
        size='sm'
        className='px-2 text-muted-foreground hover:text-foreground'
        title='扫码登录 (自动获取登录凭据)'
        onClick={() => setOpen(true)}
      >
        <QrCode className='size-4' />
      </Button>
      <AlertDialog open={open} onOpenChange={(v) => { if (!v) close() }}>
        <AlertDialogContent className='sm:max-w-sm'>
          <AlertDialogHeader>
            <AlertDialogTitle className='flex items-center justify-center gap-2'>
              <QrCode className='size-4 text-muted-foreground' />
              扫码登录微信 Claw
            </AlertDialogTitle>
            <AlertDialogDescription className='text-center'>
              微信扫码确认登录，成功后自动回填登录凭据
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className='flex min-h-64 flex-col items-center justify-center gap-3 rounded-lg border bg-muted/30 p-4'>
            {phase === 'idle' && !error && (
              <>
                <div className='size-56 animate-pulse rounded-md bg-muted' />
                <p className='text-xs text-muted-foreground'>{busy ? '正在生成二维码...' : ''}</p>
              </>
            )}
            {phase === 'pending' && image && (
              <>
                <div className='relative'>
                  <img
                    src={image}
                    alt='微信 Claw 扫码登录二维码'
                    className='size-56 rounded-md border bg-background p-2'
                  />
                  <span className='absolute inset-x-6 -bottom-2.5 mx-auto w-fit'>
                    <Badge className='animate-pulse bg-amber-500/15 text-amber-600 dark:text-amber-400'>
                      等待扫码
                    </Badge>
                  </span>
                </div>
                <p className='mt-2 text-center text-xs leading-relaxed text-muted-foreground'>
                  请使用微信「扫一扫」扫码并确认登录
                </p>
              </>
            )}
            {phase === 'connecting' && (
              <>
                <Loader2 className='size-10 animate-spin text-muted-foreground' />
                <Badge className='bg-amber-500/15 text-amber-600 dark:text-amber-400'>连接中...</Badge>
                <p className='text-center text-xs leading-relaxed text-muted-foreground'>
                  扫码成功 正在连接账号
                </p>
              </>
            )}
            {phase === 'online' && (
              <>
                <Badge className='bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'>登录成功</Badge>
                <p className='text-center text-xs leading-relaxed text-muted-foreground'>
                  账号已连接上线
                </p>
              </>
            )}
            {phase === 'expired' && (
              <>
                <Badge variant='outline' className='text-red-600 dark:text-red-400'>二维码已过期</Badge>
                <Button size='sm' className='gap-1.5' onClick={() => void start()} disabled={busy}>
                  <RefreshCw className='size-3.5' /> 重新获取
                </Button>
              </>
            )}
            {error && <p className='text-xs leading-relaxed text-red-500'>{error}</p>}
          </div>

          <AlertDialogFooter className='sm:justify-center'>
            <AlertDialogCancel onClick={close}>
              {phase === 'online' ? '完成' : '取消'}
            </AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
