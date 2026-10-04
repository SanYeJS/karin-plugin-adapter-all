# karin-plugin-adapter-SnowLuma

基于 [node-karin](https://www.npmjs.com/package/node-karin) 的多协议统一适配器插件，一套配置同时接入多种机器人协议，统一转换为 Karin 的消息与事件结构。

## 支持的协议

| 协议 | 说明 |
| --- | --- |
| OneBot 11 | 支持 SnowLuma / NapCat / Lagrange / 标准实现，通信方式支持 HTTP、正向 WebSocket、反向 WebSocket、SSE |
| OneBot 12 | 标准 OneBot 12 实现 |
| ICQQ | QQ 协议直连（快速登录 / 密码 / 扫码），支持滑动验证码多通道处理 |
| Milky | WebSocket / SSE / WebHook 三种事件接收方式 |
| Kook | 官方 API 直连，支持官方 Gateway（WS）与 WebHook 两种事件接收方式 |
| QQBot | 官方开放平台 API 直连（api-v2 鉴权），支持官方 WebSocket Gateway 与 WebHook，支持扫码绑定 AppID/AppSecret |

## 功能特性

- **可视化配置面板**：插件自带的 Web 界面支持添加 / 编辑 / 删除机器人，实时保存热更新，无需重启 Karin
- **QQBot 扫码绑定**：在配置面板扫码快速获取 AppID / AppSecret，绑定成功后自动保存配置并开始连接机器人
- **富媒体消息**：图片、语音、视频、文件消息完整支持（QQBot 走官方富媒体上传通道）
- **断线重连**：所有网络型连接均内置自动重连与心跳
- **icqq 滑动验证**：GT 网页验证、txhelper、手动 ticket、自建 Cloudflare Pages 多通道并行处理

## 安装

```bash
pnpm add karin-plugin-adapter-all -w
```

然后在 Karin 根目录启动，插件会自动注册。

> 安装时可能会看到一条 `@icqqjs/icqq` 的 404/401 警告，这是正常的（见下方「ICQQ 协议（可选）」），不影响安装和其他适配器使用。

### ICQQ 协议（可选）

`@icqqjs/icqq` 发布在 GitHub Packages（需 `read:packages` 权限），因此作为**可选依赖**：未安装时 ICQQ 适配器自动跳过，其余适配器不受影响；只有当你需要连接 ICQQ 协议时，一条命令即可（写入用户级 `.npmrc`，无需手动编辑项目根目录配置）：

```bash
npm config set @icqqjs:registry=https://npm.pkg.github.com && npm login --scope=@icqqjs --auth-type=legacy --registry=https://npm.pkg.github.com && pnpm add @icqqjs/icqq@1.12.3 -w
```

> 请勿安装 npm 上的老包 `icqq@0.6.10`，它与 `@icqqjs/icqq` 是两个不同的项目、API 完全不同。

装好后无需重启，在配置面板添加 ICQQ 机器人并保存即可热更新生效。

## 配置

访问 Karin 提供的插件 Web 控制台（默认地址与 Karin 主控制台相同），在「适配器」页面添加机器人：

1. 选择协议（OneBot 11 / OneBot 12 / ICQQ / Milky / Kook / QQBot）
2. 按需填写连接地址、Token、AppID / AppSecret 等参数
3. 保存即热更新生效

### QQBot 扫码绑定

QQBot 协议可在配置面板直接扫码：

1. 在 QQBot 配置处点击「扫码绑定」
2. 用 QQ 扫描二维码完成授权
3. 授权成功后 AppID / AppSecret 自动回填并保存，立即开始连接

### 消息正则替换

Kook / QQBot 入站消息默认开启正则替换，可将协议端命令风格转换为 Karin 默认前缀，例如：

```json
{ "match": "^\\s*\\\\/", "to": "#" }
```

将 `/命令` 转为 `#命令`。可在配置中通过 `msgReplaceEnable: false` 关闭。

## 开发

```bash
pnpm install
pnpm dev          # 开发模式（核心 + 构建 Web 面板）
pnpm build        # 编译 TS + 构建 Web 面板资源
pnpm app          # 运行编译产物
```

目录结构：

```
src/
├── adapters/        # 各协议实现（onebot11 / onebot12 / icqq / milky / kook / qqbot）
├── utils/           # 配置、扫码绑定、事件工具
├── server.ts        # 控制台服务（配置保存 API、扫码、WebHook 入口）
└── index.ts         # 插件入口
web/                 # 配置面板（Next.js + Tailwind）
```

## 自动化发布

推送到 `main` 分支后，GitHub Actions 自动完成：

1. **release-please** 依据 Conventional Commits 自动生成版本号（feat → minor，fix → patch）、打 tag 并创建 GitHub Release
2. 自动构建并发布到 npm（需配置 `NPM_TOKEN` secret）
3. **sync-build** 构建编译产物并强制同步到 `build` 分支，`build` 分支始终与最新 `main` 保持一致且包含 `dist/` 产物

日常开发流程：

```bash
git commit -m "feat: 新增 xxx"
git push
```

发布成功后在 [npm](https://www.npmjs.com/) 与 GitHub Releases 页面即可看到新版本。

## License

[MIT](./LICENSE)