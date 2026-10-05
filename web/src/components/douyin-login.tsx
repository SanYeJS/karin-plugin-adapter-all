'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckCircle2, Loader2, QrCode, RefreshCw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import {
  douyinLoginCancel, douyinLoginMfa, douyinLoginStart, douyinLoginStatus,
  authHeaders, type DouyinLoginSnapshot,
} from '@/lib/api'

/** 扫码登录成功后回填给父组件的凭据 */
export interface DouyinLoginResult {
  uid: string
  name: string
}

type Phase = DouyinLoginSnapshot['phase'] | 'idle' | 'connecting' | 'online'

/**
 * 抖音「扫码登录」: 表单内入口按钮 + 居中模态弹窗。
 * 打开即创建登录任务 → 2s 轮询状态: 展示二维码 / 扫码与验证进度,
 * MFA 阶段提交短信验证码或密码, 成功后回填并等待 bot 连接上线, 关闭时取消会话。
 */
export default function DouyinLogin ({ onBound }: { onBound: (v: DouyinLoginResult) => void }) {
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [image, setImage] = useState('')
  const [statusText, setStatusText] = useState('')
  const [successName, setSuccessName] = useState('')
  const [phase, setPhase] = useState<Phase>('idle')
  const [mfaKind, setMfaKind] = useState<'sms' | 'password' | ''>('')
  const [maskedMobile, setMaskedMobile] = useState('')
  const [verifyUrl, setVerifyUrl] = useState('')
  const [mfaCode, setMfaCode] = useState('')
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

  /** 关闭弹窗 取消后台轮询与登录任务 */
  const close = useCallback(() => {
    stopPolling()
    if (sidRef.current) {
      douyinLoginCancel(sidRef.current).catch(() => { /* 取消失败无需处理 */ })
      sidRef.current = ''
    }
    setOpen(false)
  }, [stopPolling])

  /** 轮询一次登录状态 失败停止轮询避免刷屏 */
  const poll = async (sid: string) => {
    try {
      const res = await douyinLoginStatus(sid)
      if (!res.success) throw new Error(res.message ?? '登录状态查询失败')
      const d = res.data
      if (!d) return
      setPhase(d.phase)
      if (d.image) setImage(d.image)
      if (d.statusText) setStatusText(d.statusText)
      if (d.mfaKind) setMfaKind(d.mfaKind)
      if (d.maskedMobile) setMaskedMobile(d.maskedMobile)
      setVerifyUrl(d.verifyUrl ?? '')
      if (d.error) setError(d.error)
      if (d.phase === 'success') {
        // 登录成功 → 回填凭据, 转入「连接中」阶段, 轮询 bot 连接状态
        stopPolling()
        sidRef.current = ''
        setSuccessName(d.name ?? '')
        onBoundRef.current({ uid: String(d.uid ?? ''), name: String(d.name ?? '') })
        const uid = String(d.uid ?? '')
        setPhase('connecting')
        timerRef.current = setInterval(() => { void pollConnected(uid) }, 2000)
      } else if (d.phase === 'expired') {
        stopPolling()
      }
    } catch (err) {
      stopPolling()
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  /** 轮询 bot 连接状态 连上后进入「登录成功」并自动关闭 */
  const pollConnected = async (uid: string) => {
    try {
      const res = await fetch(`/adapter-all/api/douyin/login/connected?uid=${encodeURIComponent(uid)}`, { headers: authHeaders() })
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

  /** 创建登录任务并开始轮询 */
  const start = async () => {
    stopPolling()
    setBusy(true)
    setError('')
    setSuccessName('')
    setPhase('idle')
    setImage('')
    setStatusText('')
    setMfaKind('')
    setMaskedMobile('')
    setVerifyUrl('')
    setMfaCode('')
    try {
      const res = await douyinLoginStart()
      if (!res.success || !res.data?.id) throw new Error(res.message ?? '登录任务创建失败')
      sidRef.current = res.data.id
      setPhase('pending')
      timerRef.current = setInterval(() => { void poll(sidRef.current) }, 2000)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  /** 提交 MFA 验证 (短信验证码 / 密码) 提交后继续轮询状态 */
  const submitMfa = async () => {
    const code = mfaCode.trim()
    if (!code || !sidRef.current || busy) return
    setBusy(true)
    setError('')
    try {
      const res = await douyinLoginMfa(sidRef.current, code)
      if (!res.success) setError(res.message ?? '验证失败 请重试')
      else setMfaCode('')
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  // 打开弹窗即自动创建登录任务
  useEffect(() => {
    if (open) void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  // 组件卸载时清理轮询
  useEffect(() => () => stopPolling(), [stopPolling])

  const mfaHint = mfaKind === 'password'
    ? '需要密码验证 请输入抖音账号密码'
    : maskedMobile
      ? `验证码已发送至 ${maskedMobile}`
      : '请输入短信验证码'

  return (
    <>
      <Button
        variant='ghost'
        size='sm'
        className='px-2 text-muted-foreground hover:text-foreground'
        title='扫码登录 (自动获取抖音 UID)'
        onClick={() => setOpen(true)}
      >
        <QrCode className='size-4' />
      </Button>
      <AlertDialog open={open} onOpenChange={(v) => { if (!v) close() }}>
        <AlertDialogContent className='sm:max-w-sm'>
          <AlertDialogHeader>
            <AlertDialogTitle className='flex items-center justify-center gap-2'>
              <QrCode className='size-4 text-muted-foreground' />
              扫码登录抖音
            </AlertDialogTitle>
            <AlertDialogDescription className='text-center'>
              使用抖音 App 扫码确认登录，成功后自动回填 UID 与昵称
            </AlertDialogDescription>
          </AlertDialogHeader>

          <div className='flex min-h-64 flex-col items-center justify-center gap-3 rounded-lg border bg-muted/30 p-4'>
            {(phase === 'idle' || (phase === 'pending' && !image)) && !error && (
              <>
                <div className='size-56 animate-pulse rounded-md bg-muted' />
                <p className='text-xs text-muted-foreground'>
                  {busy ? '正在获取二维码...' : (statusText || '正在获取二维码...')}
                </p>
              </>
            )}
            {phase === 'pending' && image && (
              <>
                <div className='relative'>
                  <img
                    src={image}
                    alt='抖音扫码登录二维码'
                    className='size-56 rounded-md border bg-background p-2'
                  />
                  <span className='absolute inset-x-6 -bottom-2.5 mx-auto w-fit'>
                    <Badge className='animate-pulse bg-amber-500/15 text-amber-600 dark:text-amber-400'>
                      等待扫码
                    </Badge>
                  </span>
                </div>
                <p className='mt-2 text-center text-xs leading-relaxed text-muted-foreground'>
                  请使用抖音 App「扫一扫」扫码并确认登录
                </p>
              </>
            )}
            {phase === 'scanned' && (
              <>
                <Loader2 className='size-10 animate-spin text-muted-foreground' />
                <Badge className='bg-amber-500/15 text-amber-600 dark:text-amber-400'>
                  {statusText || '已扫码'}
                </Badge>
              </>
            )}
            {phase === 'verifying' && verifyUrl && (
              <div className='flex w-full flex-col items-center gap-2'>
                <Badge className='bg-amber-500/15 text-amber-600 dark:text-amber-400'>
                  {statusText || '需要安全验证'}
                </Badge>
                <iframe
                  src={verifyUrl}
                  title='抖音安全验证'
                  className='h-80 w-full max-w-sm rounded-lg border bg-white'
                />
                <p className='text-center text-xs text-muted-foreground'>
                  在上方完成安全验证（可选可用验证方式），通过后自动继续；
                  如未展示请<a href={verifyUrl} target='_blank' rel='noreferrer' className='text-red-500 underline'>新窗口打开</a>
                </p>
              </div>
            )}
            {phase === 'verifying' && !verifyUrl && (
              <>
                <Loader2 className='size-10 animate-spin text-muted-foreground' />
                <Badge className='bg-amber-500/15 text-amber-600 dark:text-amber-400'>
                  {statusText || '验证中'}
                </Badge>
              </>
            )}
            {phase === 'mfa' && (
              <div className='flex w-full flex-col gap-2'>
                <Badge className='mx-auto bg-amber-500/15 text-amber-600 dark:text-amber-400'>需要验证</Badge>
                <p className='text-center text-xs leading-relaxed text-muted-foreground'>{mfaHint}</p>
                <Input
                  value={mfaCode}
                  type={mfaKind === 'password' ? 'password' : 'text'}
                  inputMode={mfaKind === 'password' ? undefined : 'numeric'}
                  placeholder={mfaKind === 'password' ? '账号密码' : '短信验证码'}
                  onChange={(e) => setMfaCode(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') void submitMfa() }}
                />
                <Button size='sm' disabled={busy || !mfaCode.trim()} onClick={() => void submitMfa()}>
                  {busy ? '提交中...' : '提交验证'}
                </Button>
              </div>
            )}
            {phase === 'connecting' && (
              <>
                <Loader2 className='size-10 animate-spin text-muted-foreground' />
                <Badge className='bg-amber-500/15 text-amber-600 dark:text-amber-400'>连接中...</Badge>
                {successName && (
                  <p className='text-center text-xs leading-relaxed text-muted-foreground'>
                    登录成功 正在连接账号 {successName}
                  </p>
                )}
              </>
            )}
            {phase === 'online' && (
              <>
                <CheckCircle2 className='size-14 text-emerald-500' />
                <Badge className='bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'>登录成功</Badge>
                {successName && (
                  <p className='text-center text-xs leading-relaxed text-muted-foreground'>
                    账号 {successName} 已连接上线
                  </p>
                )}
              </>
            )}
            {(phase === 'expired' || phase === 'error') && (
              <>
                <Badge variant='outline' className='text-red-600 dark:text-red-400'>
                  {phase === 'expired' ? '二维码已过期' : '登录失败'}
                </Badge>
                <Button size='sm' className='gap-1.5' onClick={() => void start()} disabled={busy}>
                  <RefreshCw className='size-3.5' /> 重新获取
                </Button>
              </>
            )}
            {error && phase !== 'error' && <p className='text-xs leading-relaxed text-red-500'>{error}</p>}
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
