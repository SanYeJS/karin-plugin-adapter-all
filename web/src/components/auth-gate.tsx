'use client'

import { useState } from 'react'
import { loginApi, setStoredAuth } from '@/lib/api'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

/**
 * WebUI 登录门: 与 Karin WebUI 同一 token (即 Karin .env 的 HTTP_AUTH_KEY)。
 * 登录成功后 token 存入 localStorage, 后续请求以 Authorization: Bearer 携带。
 */
export default function AuthGate ({ onSuccess }: { onSuccess: () => void }) {
  const [token, setToken] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const submit = async () => {
    const t = token.trim()
    if (!t) { setError('请输入 token'); return }
    setLoading(true)
    setError('')
    try {
      const res = await loginApi(t)
      if (res.success) {
        setStoredAuth(t)
        onSuccess()
      } else {
        setError(res.message || 'token 错误')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className='flex h-screen items-center justify-center px-4'>
      <div className='w-full max-w-xs space-y-4'>
        <div className='text-center'>
          <h1 className='text-lg font-semibold'>Karin 适配器</h1>
          <p className='mt-1 text-sm text-muted-foreground'>请输入 WebUI token 登录</p>
        </div>
        <Input
          type='password'
          value={token}
          autoFocus
          placeholder='WebUI token'
          disabled={loading}
          onKeyDown={(e) => { if (e.key === 'Enter') void submit() }}
          onChange={(e) => setToken(e.target.value)}
        />
        {error && <p className='text-center text-xs text-destructive'>{error}</p>}
        <Button className='w-full' disabled={loading} onClick={() => void submit()}>
          {loading ? '登录中...' : '登录'}
        </Button>
      </div>
    </div>
  )
}
