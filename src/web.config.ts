import { defineConfig } from 'node-karin'
import { dir } from '@/dir'
import { WEB_PREFIX } from '@/utils/config'

/**
 * 自定义页面模式: 不使用 Karin 内置组件, 由插件自带的 Next.js 配置页面提供服务
 * 生产环境: 同源路径 /adapter-all/ (next 静态导出产物由 src/server.ts 同源托管)
 * 开发环境: next dev 地址, 可在配置面板顶栏填入 Karin 后端地址联调
 */
export default defineConfig({
  info: {
    id: dir.name,
    name: '多协议适配器',
    author: { name: 'shijin', home: 'https://github.com/KarinJS/karin', avatar: 'https://github.com/KarinJS.png' },
    icon: { name: 'dns', size: 24, color: '#1677ff' },
    version: dir.version,
    description: '多协议统一适配器: onebot11(snowluma/napcat/lagrange) | onebot12 | icqq | milky',
  },
  page: {
    url:
      process.env.NODE_ENV === 'development'
        ? `http://localhost:4111${WEB_PREFIX}/?host=http://localhost:${process.env.HTTP_PORT ?? 7777}`
        : `${WEB_PREFIX}/`,
    title: '多协议适配器配置',
    description: '使用插件自带 Next.js 配置页面管理 Bot 连接, 保存后自动热更新生效',
  },
})