'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ExternalLink, LayoutGrid, PanelLeft, Plus, RotateCw, Save, Settings,
} from 'lucide-react'
import { useTheme } from 'next-themes'
import { toast } from 'sonner'
import {
  fetchConfig, fetchIcqqStatus, fromForm, getStoredAuth, saveConfigApi, toForm, UNAUTHORIZED_EVENT,
  type BotConfig, type BotForm,
} from '@/lib/api'
import BotCard from '@/components/bot-card'
import AuthGate from '@/components/auth-gate'
import { Avatar, ListSkeleton, PageSkeleton } from '@/components/skeleton'
import { Accordion } from '@/components/ui/accordion'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface BotItem {
  id: number
  form: BotForm
}

/** 侧边栏展示的 GitHub 信息 */
const GITHUB = {
  name: 'dmmdekkd',
  url: 'https://github.com/dmmdekkd',
  avatar: 'https://github.com/dmmdekkd.png',
}

const TABS = [
  { key: 'config', label: '连接配置', icon: LayoutGrid },
  { key: 'settings', label: '设置', icon: Settings },
] as const
type TabKey = (typeof TABS)[number]['key']

/** 顶部协议分类 tabs (每种协议一个 tab, 添加连接始终归属当前 tab 并自动定位) */
const FILTER_TABS = [
  { key: 'onebot11', label: 'OneBot 11' },
  { key: 'onebot12', label: 'OneBot 12' },
  { key: 'icqq', label: 'ICQQ' },
  { key: 'milky', label: 'Milky' },
  { key: 'kook', label: 'Kook' },
  { key: 'qqbot', label: 'QQBot' },
  { key: 'douyin', label: '抖音' },
  { key: 'wxoc', label: '微信 Claw' },
] as const
type FilterKey = (typeof FILTER_TABS)[number]['key']

export default function ConfigPage () {
  const { theme, setTheme } = useTheme()

  const [items, setItems] = useState<BotItem[]>([])
  const seq = useRef(0)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  /** 手动刷新配置中 (顶部刷新按钮旋转动画) */
  const [refreshing, setRefreshing] = useState(false)
  /** @icqqjs/icqq 是否已安装 (false 时 ICQQ 卡片展示安装引导) */
  const [icqqAvailable, setIcqqAvailable] = useState(true)
  /** 必填红框仅保存校验失败后展示, 输入过程不打扰 */
  const [showErrors, setShowErrors] = useState(false)

  // 侧边栏与导航 (默认收起)
  const [collapsed, setCollapsed] = useState(true)
  const [tab, setTab] = useState<TabKey>('config')

  /** 登录门: null=校验中 false=未登录 true=已登录 (401 时自动回到登录页) */
  const [authed, setAuthed] = useState<boolean | null>(null)

  useEffect(() => {
    setAuthed(Boolean(getStoredAuth()))
    const onUnauthorized = () => setAuthed(false)
    window.addEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
    return () => window.removeEventListener(UNAUTHORIZED_EVENT, onUnauthorized)
  }, [])

  // 顶部协议分类
  const [filter, setFilter] = useState<FilterKey>('onebot11')

  /** 拉取配置并重建表单列表; showToast=true 时 (手动刷新) 成功后提示 */
  const loadConfig = useCallback(async (showToast = false) => {
    try {
      const cfg = await fetchConfig()
      const list = (Array.isArray(cfg.bots) ? cfg.bots : []) as BotConfig[]
      setItems(list.map((b) => ({ id: ++seq.current, form: toForm(b) })))
      setShowErrors(false)
      if (showToast) toast.success('配置已刷新')
    } catch (err) {
      toast.error(`加载配置失败: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setLoading(false)
    }
  }, [])

  /** 手动刷新: 重新拉取配置与 icqq 安装状态 (丢弃未保存的修改) */
  const refresh = useCallback(async () => {
    setRefreshing(true)
    await loadConfig(true)
    fetchIcqqStatus().then(setIcqqAvailable).catch(() => setIcqqAvailable(true))
    setRefreshing(false)
  }, [loadConfig])

  useEffect(() => {
    // 登录通过后才拉取数据 (token 失效时 401 事件会把 authed 置回 false)
    if (authed !== true) return
    void loadConfig()
    fetchIcqqStatus().then(setIcqqAvailable).catch(() => setIcqqAvailable(true))
  }, [authed, loadConfig])

  const patchItem = useCallback((id: number, patch: Partial<BotForm>) => {
    setItems((prev) => prev.map((it) => (it.id === id ? { ...it, form: { ...it.form, ...patch } } : it)))
    // 卡片内切换协议: 该连接已不属于当前 tab, 自动切换分组保持可见
    if (patch.protocol && (FILTER_TABS as readonly { key: string }[]).some((t) => t.key === patch.protocol)) {
      setFilter(patch.protocol as FilterKey)
    }
  }, [])

  const removeItem = useCallback((id: number) => {
    setItems((prev) => prev.filter((it) => it.id !== id))
  }, [])

  const addItem = useCallback((protocol?: BotConfig['protocol']) => {
    // 以空配置为基底 (触发默认值预填, 如消息正则替换), 仅覆盖协议
    const form = toForm()
    if (protocol) form.protocol = protocol
    setItems((prev) => [...prev, { id: ++seq.current, form }])
  }, [])

  /**
   * 添加连接并自动定位: 新连接始终按当前 tab 的协议创建;
   * 若协议与当前 tab 不一致 (如默认协议兜底时) 则自动切换到对应 tab, 保证新卡片立即可见
   */
  const addItemAndLocate = (protocol?: BotConfig['protocol']) => {
    addItem(protocol ?? (filter as BotConfig['protocol']))
    if (protocol && protocol !== filter) setFilter(protocol)
  }

  const validBots = items.map((it) => fromForm(it.form)).filter((b): b is BotConfig => Boolean(b))

  /** 按顶部协议分类过滤后的连接 */
  const filteredItems = items.filter((it) => it.form.protocol === filter)

  const save = async () => {
    // 保存时才标记展示必填红框
    setShowErrors(true)
    // 保存前校验: icqq 检查 QQ 号(扫码登录除外); kook/qqbot 为官方 API 直连, 检查 token/appid;
    // douyin 检查扫码回填的 uid; wxoc 检查扫码回填的 token+机器人ID; 其余协议检查连接地址
    const missingIcqq = (it: BotItem) => it.form.protocol === 'icqq' && it.form.loginType !== 'qrcode' && !it.form.uin.trim()
    const missingKook = (it: BotItem) =>
      it.form.protocol === 'kook' &&
      (!it.form.kookToken.trim() || (it.form.kookEventMode === 'webhook' && !it.form.kookWebhookUrl.trim()))
    const missingQqBot = (it: BotItem) =>
      it.form.protocol === 'qqbot' &&
      (!it.form.qqbotAppId.trim() || !it.form.qqbotClientSecret.trim() || (it.form.qqbotEventMode === 'webhook' && !it.form.qqbotWebhookUrl.trim()))
    const missingDouyin = (it: BotItem) => it.form.protocol === 'douyin' && !it.form.douyinUid.trim()
    const missingWxoc = (it: BotItem) =>
      it.form.protocol === 'wxoc' && (!it.form.wxocToken.trim() || !it.form.wxocAccountId.trim())
    const needUrl = items.filter((it) =>
      it.form.enable &&
      (missingIcqq(it) || missingKook(it) || missingQqBot(it) || missingDouyin(it) || missingWxoc(it) ||
        (!['icqq', 'kook', 'qqbot', 'douyin', 'wxoc'].includes(it.form.protocol) && !it.form.url.trim())),
    )
    if (needUrl.length) {
      const label = needUrl.some((it) => it.form.protocol === 'icqq') ? 'QQ 号'
        : needUrl.some((it) => it.form.protocol === 'kook') ? 'Kook Token'
          : needUrl.some((it) => it.form.protocol === 'qqbot') ? 'AppID / Token'
            : needUrl.some((it) => it.form.protocol === 'douyin') ? '抖音 UID'
              : needUrl.some((it) => it.form.protocol === 'wxoc') ? 'Token / 机器人 ID'
                : '连接地址'
      toast.error(`有 ${needUrl.length} 个已启用的连接未填写「${label}」，请补充必填项后再保存`)
      return
    }
    // HTTP/SSE 模式必须配置事件地址
    const needEvent = items.filter(
      (it) => it.form.enable && it.form.protocol === 'onebot11' && ['http', 'sse'].includes(it.form.communication) && !it.form.eventUrl.trim(),
    )
    if (needEvent.length) {
      toast.error(`有 ${needEvent.length} 个已启用的连接未填写「事件上报/流地址」，请补充后再保存`)
      return
    }
    // ICQQ 未安装时直接拦截, 引导先装包 (后端 POST 也有兜底校验)
    if (items.some((it) => it.form.enable && it.form.protocol === 'icqq') && !icqqAvailable) {
      toast.error('ICQQ 机器人需要安装 icqq (@icqqjs/icqq)，安装命令见 ICQQ 卡片提示，装好后保存即生效')
      return
    }
    setSaving(true)
    try {
      const res = await saveConfigApi({ bots: validBots })
      if (res.success) {
        toast.success(res.message)
        setShowErrors(false)
      } else toast.error(res.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  /**
   * qqbot 扫码绑定成功后回调:
   * 凭证已通过 onBound 回填表单, 这里立即把更新后的配置保存到后端,
   * 触发 config 热更新创建 QqBotBot 并连接官方网关, 避免流程停在手动保存一步。
   */
  const handleQrBound = async (id: number, v: { appId: string; appSecret: string }) => {
    const merged = items.map((it) =>
      it.id === id
        ? { ...it, form: { ...it.form, qqbotAppId: v.appId, qqbotClientSecret: v.appSecret } }
        : it,
    )
    setItems(merged)
    const bots = merged.map((it) => fromForm(it.form)).filter((b): b is BotConfig => Boolean(b))
    setSaving(true)
    try {
      const res = await saveConfigApi({ bots })
      if (res.success) toast.success('绑定成功，正在连接机器人')
      else toast.error(res.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  /**
   * 抖音/微信 Claw 扫码登录成功: 回填凭据并立即保存触发热更新注册,
   * 避免服务端单独写入被随后的手动保存覆盖 (与 qqbot 绑定同源, 前端为唯一写入方)
   */
  const handleLoginBound = async (id: number, protocol: 'douyin' | 'wxoc', v: Partial<BotForm>) => {
    const merged = items.map((it) => (it.id === id ? { ...it, form: { ...it.form, ...v } } : it))
    setItems(merged)
    const bots = merged.map((it) => fromForm(it.form)).filter((b): b is BotConfig => Boolean(b))
    setSaving(true)
    try {
      const res = await saveConfigApi({ bots })
      if (res.success) toast.success(protocol === 'douyin' ? '登录成功，正在连接抖音账号' : '登录成功，正在连接微信账号')
      else toast.error(res.message)
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  if (authed !== true) {
    // 校验本地凭证期间展示与真实布局同构的整页骨架, 未登录则展示登录页
    if (authed === null) return <PageSkeleton />
    return (
      <AuthGate
        onSuccess={() => setAuthed(true)}
      />
    )
  }

  return (
    <div className='flex h-screen overflow-hidden'>
      {/* 侧边栏 */}
      <aside
        className={cn(
          'flex h-full shrink-0 flex-col border-r bg-muted/40 transition-[width] duration-200',
          collapsed ? 'w-14' : 'w-60',
        )}
      >
        {/* GitHub 头像与名称 (图片加载完成前展示圆形骨架) */}
        <div className={cn('flex items-center gap-3 p-3', collapsed && 'justify-center px-0')}>
          <a href={GITHUB.url} target='_blank' rel='noreferrer' className='shrink-0' title='GitHub'>
            <Avatar src={GITHUB.avatar} alt={GITHUB.name} className='size-9 ring-1 ring-border' />
          </a>
          {!collapsed && (
            <div className='min-w-0'>
              <p className='truncate text-sm font-semibold'>{GITHUB.name}</p>
              <p className='flex items-center gap-1 truncate text-xs text-muted-foreground'>
                <ExternalLink className='size-3' /> GitHub
              </p>
            </div>
          )}
        </div>

        <div className='mx-3 my-2 h-px bg-border' />

        {/* Tab 切换 */}
        <nav className='flex flex-col gap-1 px-2'>
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              title={label}
              className={cn(
                'flex items-center gap-3 rounded-md px-2.5 py-2 text-sm font-medium transition-colors',
                collapsed && 'justify-center px-0',
                tab === key
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              <Icon className='size-4 shrink-0' />
              {!collapsed && label}
            </button>
          ))}
        </nav>

        {/* 折叠按钮 */}
        <div className='mt-auto p-2'>
          <Button
            variant='ghost'
            size={collapsed ? 'icon' : 'default'}
            className={cn(
              'gap-3',
              collapsed ? 'mx-auto flex size-8 p-0' : 'w-full justify-start px-2.5',
            )}
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? '展开侧边栏' : '收起侧边栏'}
          >
            <PanelLeft className='size-4 shrink-0' />
            {!collapsed && <span className='text-sm'>收起侧边栏</span>}
          </Button>
        </div>
      </aside>

      {/* 主体 */}
      <main className='flex-1 overflow-y-auto'>
        {tab === 'settings' ? (
          <div className='mx-auto max-w-2xl px-6 py-8'>
            <div className='space-y-6'>
              <div>
                <h2 className='text-lg font-semibold'>设置</h2>
                <p className='text-sm text-muted-foreground'>界面外观</p>
              </div>

              <div className='space-y-2'>
                <Label>主题</Label>
                <Select value={theme ?? 'system'} onValueChange={setTheme}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='light'>浅色</SelectItem>
                    <SelectItem value='dark'>深色</SelectItem>
                    <SelectItem value='system'>跟随系统</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        ) : (
          <div className='mx-auto max-w-[1440px] px-4 py-6 sm:px-6'>
            {loading ? (
              // 首次拉取配置: 统计文案/tabs/卡片网格专属骨架
              <ListSkeleton />
            ) : (
              <>
                <div className='flex flex-wrap items-center justify-between gap-3 pb-4'>
                  <p className='text-sm text-muted-foreground'>
                    管理适配器下的 Bot 连接，共{' '}
                    <span className='font-medium text-foreground'>{items.length}</span> 个配置
                    {validBots.length < items.length && (
                      <>，有效 <span className='font-medium text-foreground'>{validBots.length}</span> 个</>
                    )}
                  </p>
                  <div className='flex items-center gap-2'>
                    <Button
                      variant='outline'
                      size='icon'
                      title='重新加载配置 (丢弃未保存的修改)'
                      disabled={refreshing}
                      onClick={() => void refresh()}
                    >
                      <RotateCw className={cn(refreshing && 'animate-spin')} />
                    </Button>
                    <Button variant='outline' onClick={() => addItemAndLocate()}>
                      <Plus /> 添加连接
                    </Button>
                    <Button onClick={save} disabled={saving}>
                      <Save /> {saving ? '保存中...' : '保存配置'}
                    </Button>
                  </div>
                </div>

                {/* 顶部协议分类 tabs */}
                <div className='pb-4'>
                  <div className='inline-flex max-w-full flex-wrap items-center gap-1 rounded-lg bg-muted p-1'>
                    {FILTER_TABS.map(({ key, label }) => {
                      const count = items.filter((it) => it.form.protocol === key).length
                      return (
                        <button
                          key={key}
                          onClick={() => setFilter(key)}
                          className={cn(
                            'flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
                            filter === key
                              ? 'bg-background text-foreground shadow-sm'
                              : 'text-muted-foreground hover:text-foreground',
                          )}
                        >
                          {label}
                          <span
                            className={cn(
                              'rounded-full px-1.5 text-xs tabular-nums',
                              filter === key ? 'bg-primary text-primary-foreground' : 'bg-border text-muted-foreground',
                            )}
                          >
                            {count}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                </div>

                {filteredItems.length === 0 ? (
                  <div className='flex flex-col items-center gap-4 rounded-xl border border-dashed py-24'>
                    <p className='text-sm text-muted-foreground'>
                      {items.length === 0 ? '暂无连接配置' : '该分类下暂无连接'}
                    </p>
                    <Button onClick={() => addItemAndLocate()}>
                      <Plus /> 添加连接
                    </Button>
                  </div>
                ) : (
                  <Accordion
                    type='multiple'
                    className={cn(
                      'grid grid-cols-1 items-start gap-4',
                      filteredItems.length > 1 && 'md:grid-cols-2 2xl:grid-cols-3',
                    )}
                  >
                    {filteredItems.map((it, i) => (
                      <BotCard
                        key={it.id}
                        value={String(it.id)}
                        index={i}
                        form={it.form}
                        icqqAvailable={icqqAvailable}
                        showErrors={showErrors}
                        onChange={(patch) => patchItem(it.id, patch)}
                        onRemove={() => removeItem(it.id)}
                        onQrBound={(v) => void handleQrBound(it.id, v)}
                        onDouyinBound={(v) => void handleLoginBound(it.id, 'douyin', v)}
                        onWxocBound={(v) => void handleLoginBound(it.id, 'wxoc', v)}
                      />
                    ))}
                  </Accordion>
                )}
              </>
            )}
          </div>
        )}
      </main>
    </div>
  )
}