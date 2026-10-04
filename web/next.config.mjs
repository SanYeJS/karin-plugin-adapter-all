/**
 * @description 适配器配置页面静态导出配置
 * - output: 'export' 纯静态导出, 由插件后端同源托管
 * - basePath 必须与后端挂载前缀一致 (默认 /adapter-all)
 */
/** @type {import('next').NextConfig} */
const nextConfig = {
  output: 'export',
  basePath: '/adapter-all',
  trailingSlash: true,
  images: { unoptimized: true },
  // 子工程未配置 ESLint 规则集 构建期跳过 lint (类型检查仍生效)
  eslint: { ignoreDuringBuilds: true },
}

export default nextConfig