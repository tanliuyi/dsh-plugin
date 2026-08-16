# @dsh-plugins/dsh-web-app

完全独立的 dsh Web UI。**不依赖 `@deepseek-ai/dsh-web-app`**：不加载其 bundle、
前端产物、shell 内核（`dsh-client-web`）与任何 `dsh-client-ui-*` 插件。

- Host 组合层（`cordis.patch.yml`）：自建 web 传输 —— `webserver` +
  `apiproxy` + `client-connection`（`/api` 路由与 WebSocket downlink）+ 自研
  SPA 静态服务。
- 前端（`web/`）：**Vite + React + assistant-ui 官方组件**（shadcn registry 安装
  Thread / ThreadList / MarkdownText / ToolFallback 等）+ tailwind v4 主题，
  直连公开的 `/api` 传输协议（`POST /api/<method>` 一元 RPC +
  `/api/events.mux`、`/api/events.host` 下行流），不注入 `window.__DSH_BOOT__`。

## 使用

```sh
pnpm install                          # 根 workspace
pnpm --dir packages/dsh-web-app/web install   # 前端子包依赖
pnpm build                            # tsc（host 插件）→ lib/；vite → web/dist/
# 创建并使用独立 profile（与官方 web profile 隔离）：
dsh --profile wui                     # 默认 http://127.0.0.1:3090
dsh --profile wui --port 8080         # 覆盖端口
# 前端热开发（代理 /api 到 3090）：
pnpm --dir web dev
```

profile 的 bundle 栈：

```jsonc
// ~/.dsh/profiles/wui/package.json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@dsh-plugins/dsh-web-app"
] } }
```

## 结构

```
src/startup.ts    # --host/--port/--trusted-host → webStartup 服务
src/index.ts      # 主插件：SPA fallback seat + URL 打印
cordis.patch.yml  # host 组合层（替换 @deepseek-ai/dsh-web-app 的传输行）
web/              # 独立前端（Vite + React + assistant-ui 官方组件）
  src/dsh/        #   协议层：api（/api RPC）、messages（SessionEvent 组装）、store、stream
  src/runtime/    #   ExternalStoreRuntime 适配（convertMessage/onNew/onCancel/threadList）
  src/components/assistant-ui/  # 官方组件（shadcn registry 安装）
  src/components/ui/            # shadcn 基础组件
  src/globals.css #   tailwind v4 + shadcn/assistant-ui 主题
tests/            #   Playwright 端到端验证
```

## 协议对接（已实现）

| 通道 | 用途 |
| --- | --- |
| `POST /api/<method>` | 一元 RPC：session.*、workspace.*、host.*、settings.* 等 |
| `POST /api/respond` | 应答 server-request（审批/提问） |
| `WS /api/events.mux` | 会话事件流（session/event、queue、approval、projection…） |
| `WS /api/events.host` | host 级事件流（会话创建/销毁/运行状态） |

契约类型与 zod schema 可复用 `@deepseek-ai/dsh-host-apiproxy/api`
（零 Node 依赖、浏览器可导入）；浏览器传输实现参考
`@deepseek-ai/dsh-client-connection/client` 的 `WebApiClient`。

## 现状

- [x] 自建 host 传输组合，与官方 web profile 完全隔离（默认端口 3090）
- [x] `/api` 一元 RPC + 双 WebSocket downlink
- [x] host.describe / session.list / session.create
- [x] 会话历史渲染（assistant-ui 官方 Thread：markdown、reasoning 折叠、
      工具调用卡片；assistant/message 按 block 类型解析，reasoning 不混入正文）
- [x] 上下文注入折叠（runtime context / skill 目录等 source.kind ≠ user 的
      user/message 折叠为一行小字，只有真实用户消息渲染为气泡）
- [x] session.prompt 发送（文本 + 图片附件）+ 运行状态 + 取消
- [x] 官方 ThreadList 会话列表（213+ 会话、新建、归档）
- [x] 会话滚动（grid 子项 min-h-0 约束，Viewport 内部滚动）
- [x] assistant-ui ExternalStoreRuntime 适配（convertMessage/onNew/onCancel/threadList）
- [x] tailwind v4 + shadcn 主题（深色/浅色，跟随系统）
- [x] Playwright 端到端验证（新建会话 → 发送 → 回复渲染，零错误）
- [ ] 审批/提问应答 UI、队列管理
- [ ] 设置/模型页（settings.* / credentials.* / llm.*）
- [ ] 工作区管理、子代理、任务/目标
- [ ] 会话搜索、ThreadList 分组与分页
