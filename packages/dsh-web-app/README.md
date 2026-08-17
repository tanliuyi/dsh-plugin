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
- [x] `/api` 一元 RPC + 双 WebSocket downlink，支持 envelope/raw frame 兼容和自动重连
- [x] host/session/workspace 基础生命周期：describe、list、create、history、rename、fork、archive
- [x] assistant-ui 官方 Thread/ThreadList/Composer：Markdown、reasoning、附件、工具 fallback、External Store Runtime
- [x] 多 step turn 的运行态：工具完成和中间 assistant message 不会提前结束，只有 turn/end 或 host status 结束
- [x] 上下文注入折叠、图片 hydration、工具错误卡片、审批/提问应答
- [x] queue/jobs/projection、goal、model/reasoning、agent preset、subagent 基础能力
- [x] settings namespace JSON 编辑、远端 session 搜索、workspace 分组/平铺/排序
- [x] tailwind v4 + shadcn 主题（深色/浅色，跟随系统）

详细对齐矩阵见 [UPSTREAM-ALIGNMENT.md](./UPSTREAM-ALIGNMENT.md)。当前剩余缺口主要是 credentials/provider onboarding、agent preset authoring、skills/web search 业务协议、produced files、队列 edit、反馈和 session-log export；分页、虚拟化、滚动锚定及专用卡片属于可选 UI 层能力，不作为本包的功能对齐要求。
