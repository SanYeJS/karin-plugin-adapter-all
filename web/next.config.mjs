/**
 * @description 适配器配置页面静态导出配置
 * - output: 'export' 纯静态导出, 由插件后端同源托管
 * - basePath 必须与后端挂载前缀一致 (默认 /adapter-all)
 */
import { fileURLToPath } from 'node:url'

/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath: '/adapter-all',
  trailingSlash: true,
  images: { unoptimized: true },
  // 子工程未配置 ESLint 规则集 构建期跳过 lint (类型检查仍生效)
  eslint: { ignoreDuringBuilds: true },
  // web 独立于根 workspace 管理依赖，显式指定 trace 根目录
  // 否则 Next.js 会把含多个 lockfile 的仓库根目录误判为 workspace root
  outputFileTracingRoot: fileURLToPath(new URL('.', import.meta.url)),
}

export default nextConfig