'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'

/** 基础骨架块 */
export function Skeleton ({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-muted', className)} />
}

/**
 * 头像: 图片加载完成前展示圆形骨架, 加载完成后淡入
 * 侧边栏 GitHub 头像等位置使用
 */
export function Avatar ({ src, alt, className }: { src: string, alt: string, className?: string }) {
  const [loaded, setLoaded] = useState(false)
  return (
    <span className={cn('relative inline-block shrink-0 overflow-hidden rounded-full', className)}>
      {!loaded && <Skeleton className='absolute inset-0 rounded-full' />}
      <img
        src={src}
        alt={alt}
        onLoad={() => setLoaded(true)}
        className={cn('size-full rounded-full transition-opacity duration-300', loaded ? 'opacity-100' : 'opacity-0')}
      />
    </span>
  )
}

/** 连接卡片骨架 (头像位 + 标题两行 + 状态徽标 + 表单行) */
export function BotCardSkeleton () {
  return (
    <div className='rounded-xl border bg-card p-4'>
      <div className='flex items-center gap-3'>
        <Skeleton className='size-10 shrink-0 rounded-full' />
        <div className='flex-1 space-y-2'>
          <Skeleton className='h-4 w-1/3' />
          <Skeleton className='h-3 w-1/2' />
        </div>
        <Skeleton className='h-6 w-16 rounded-full' />
      </div>
      <div className='mt-4 space-y-2.5'>
        <Skeleton className='h-3 w-16' />
        <Skeleton className='h-9 w-full rounded-md' />
        <Skeleton className='h-3 w-16' />
        <Skeleton className='h-9 w-full rounded-md' />
      </div>
    </div>
  )
}

/** 配置列表加载骨架 (头部统计 + 按钮 + 协议 tabs + 卡片网格) */
export function ListSkeleton () {
  return (
    <>
      <div className='flex flex-wrap items-center justify-between gap-3 pb-4'>
        <Skeleton className='h-4 w-44' />
        <div className='flex items-center gap-2'>
          <Skeleton className='size-9 rounded-md' />
          <Skeleton className='h-9 w-24 rounded-md' />
          <Skeleton className='h-9 w-28 rounded-md' />
        </div>
      </div>
      <div className='pb-4'>
        <Skeleton className='h-10 w-full max-w-xl rounded-lg' />
      </div>
      <div className='grid grid-cols-1 items-start gap-4 md:grid-cols-2 2xl:grid-cols-3'>
        {Array.from({ length: 6 }, (_, i) => <BotCardSkeleton key={i} />)}
      </div>
    </>
  )
}

/** 校验凭证整页骨架 (侧边栏 + 主区, 与真实布局同构) */
export function PageSkeleton () {
  return (
    <div className='flex h-screen overflow-hidden'>
      <div className='flex w-60 shrink-0 flex-col gap-4 border-r bg-muted/40 p-3'>
        <div className='flex items-center gap-3'>
          <Skeleton className='size-9 rounded-full' />
          <div className='flex-1 space-y-2'>
            <Skeleton className='h-3.5 w-20' />
            <Skeleton className='h-3 w-14' />
          </div>
        </div>
        <Skeleton className='h-9 w-full rounded-md' />
        <Skeleton className='h-9 w-full rounded-md' />
      </div>
      <div className='flex-1 overflow-hidden p-6'>
        <div className='mx-auto max-w-[1440px]'>
          <ListSkeleton />
        </div>
      </div>
    </div>
  )
}
