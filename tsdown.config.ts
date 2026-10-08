import { defineConfig } from 'tsdown'
import type { UserConfig } from 'tsdown'

/**
 * @description `tsdown` configuration options
 */
export const options: UserConfig = {
  entry: ['src/*.ts'], // 入口文件
  format: ['esm'], // 输出格式
  target: 'node18', // 目标环境
  sourcemap: false, // 是否生成 sourcemap
  clean: true, // 是否清理输出目录
  dts: false, // 是否生成 .d.ts 文件 没啥事可以不需要生成类型，除非你的插件会被其他插件调用。
  outDir: 'dist', // 输出目录
  treeshake: false, // 树摇优化
  minify: false, // 压缩代码
  // @snowluma/sdk 的 dist 使用无扩展名 ESM 导入, 纯 node ESM 无法解析 (ERR_MODULE_NOT_FOUND),
  // 构建期内联进产物以规避; icqq 为可选依赖，不打包；缺失时由 adapters/index.ts 动态加载并给出提示
  noExternal: [
    '@snowluma/sdk',
    /^@snowluma\//,
  ],
  deps: {
    neverBundle: [
      'node-karin',
      /^node-karin\//,
      '@icqqjs/icqq',
      /^@icqqjs\/icqq\//,
      'icqq',
      /^icqq\//,
    ],
  },
  shims: true,
  outExtensions () {
    return {
      js: '.js',
    }
  },
}

export default defineConfig(options)
