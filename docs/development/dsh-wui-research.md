# dsh-wui 调研：完全独立的 dsh Web UI 应用

> 目标：新建插件 `dsh-wui`，**完全不依赖 `@deepseek-ai/dsh-web-app`**（不加载其 bundle、前端产物、shell 内核与 ui-* 插件阵容），做成一个独立的前端应用，通过 dsh 公开的 `/api` 传输协议与 host 通信。
>
> 调研基线：本地安装 `@deepseek-ai/dsh@0.1.0-rc.6`；上游 `deepseek-ai/deepseek-harness` HEAD `47f9438`（2026-08-13）。协议处于 developer preview，可能破坏性变更。

## 1. 现状：dsh web UI 由什么组成

`dsh web` 只是 `--profile web` 的别名（`apps/cli/src/args.ts`）。profile 是一个 bundle 栈（`dsh.profile.bundles`，见 `~/.dsh/profiles/web/package.json`），每个 bundle 贡献一层 `cordis.patch.yml`，栈序：**dsh-base → dsh-web-app → 用户包**。

### 1.1 前端产物与 shell 内核

| 包 | 目录 | 作用 |
| --- | --- | --- |
| `@deepseek-ai/dsh-web-frontend` | `apps/web` | Vite 构建的 SPA（`index.html` + assets）。入口极薄：`main.ts` 只做 `new AppWebEntry(el).run()` |
| `@deepseek-ai/dsh-client-web` | `packages/client/web` | shell 内核，两阶段启动：解析 `window.__DSH_BOOT__` → 模块系统 → 加载器（`cordis-plugin-loader`，`internal` 注入模块系统）→ 逐行创建插件入口 → 全 ACTIVE 校验 → `AppRoot` 渲染 `ctx.slots.renderSlot('root', {})` |
| `@deepseek-ai/dsh-client-web-react` | `packages/client/web-react` | React 绑定（快照选择器、slot renderer） |

### 1.2 浏览器插件阵容（~30 个 `dsh-client-ui-*`）

全部由 `@deepseek-ai/dsh-web-app` 的 `cordis.patch.yml`（`packages/bundle/web-app/`）以 `dsh.client` 行组装，经 `client-modules` node half 扫描后注入 `__DSH_BOOT__` 并服务 `/plugins/<id>/client.js`：

- `ui-layout`（678 行）— 三栏 AppFrame，注册进内置 `root` 单座槽，声明 `sidebar` / `conversation` / `details` / `shell.overlay` 子槽
- `ui-sidebar`（399 行）、`ui-workspace`（2973 行）、`ui-conversation`（**11310 行**）、`ui-settings`（482 行）+ 各设置页、`ui-tool`（2300 行）、`ui-cordis`、`ui-trajectory`、`ui-plan`、`ui-goal`、`ui-jobs`、`ui-subagent` 等
- 运行时服务：`dsh-client-runtime`（`sessions` / `workspaces` / `slots` 服务 + mux 流消费 + 会话事件组装）、`locale`、`theme`、`connection`（浏览器 half）

### 1.3 host 侧 web 传输层（web-app bundle 的 host 行）

| 行 id | 包 | 职责 |
| --- | --- | --- |
| `web-startup` | `@deepseek-ai/dsh-web-app/startup` | 解析 CLI 参数 → `webStartup` 服务（host/port/trustedHosts） |
| `webserver` | `@deepseek-ai/dsh-host-webserver` | HTTP 服务（默认 127.0.0.1:3080）、`register` / `registerFallback`（**单座**）/ `registerUpgrade` / `tapIndex` |
| `web-runtime` | `@deepseek-ai/dsh-web-app` | 解析前端 dist（`resolveDistIndex` 硬编码解析 `dsh-web-frontend/dist/index.html`）、挂 `frontend-static` fallback、打印 URL 行、注册 `app:web-surface` prompt 段、`DSH_WEB_URL` shell 变量 |
| `api-gateway` | `@deepseek-ai/dsh-host-apiproxy` | **transport-agnostic** 的 `/api` 网关（`ctx.apiProxy`），业务服务通过 `@Remote` 暴露 |
| `connection` | `@deepseek-ai/dsh-client-connection`（node half） | 注册 `/api` 前缀路由（信任围栏 → `toFetchHandler` → apiProxy）、`/api/events.mux` 与 `/api/events.host` 两条 WebSocket downlink |
| `modules` | `@deepseek-ai/dsh-client-modules`（node half） | 扫描 `dsh.client` 包 → 组装 `__DSH_BOOT__` → index-tap 注入 → 服务 `/plugins/<id>/client.js` |
| `client-runtime` / `cordis-client-runner` / `agent-presets` 等 | — | 浏览器运行时与 preset 行 |

`dsh-base`（`packages/bundle/base/`）不含任何 HTTP/浏览器行——它是纯 host 核心：llm、session、agent、typert、settings、credentials、jobs、sandbox、approval、tools、commands、goal、plan、subagents、workflow、web 搜索等。headless profile 就是 `dsh-base + dsh-headless`（无 HTTP 层）的对照先例。

## 2. 完全独立的可行路径（协议面）

官方架构明确支持非官方前端：apiproxy 是 **transport-agnostic** 的（"the API gateway every client shape shares"），`api/` 契约层**零 Node 依赖、浏览器可直接 import**（TS 接口 + zod schema）。前端只需要实现：

### 2.1 传输载体

| 通道 | 形态 | 载荷 |
| --- | --- | --- |
| `POST /api/<method>` | HTTP unary | `ClientRequest` → `ServerResponse`（业务错误也是 200，`result.ok=false` + 错误码） |
| `POST /api/respond` | HTTP | `ClientResponse`（对 server-request 的应答，如审批/提问），返回 `RpcReceipt` |
| `WS /api/events.mux` | 下行单向 | `ServerRequest` 帧：`session/event`、`session/subscribed`、`approval/requested|resolved`、`question/requested|resolved`、`session/queue`、`session/jobs`、`session/projection`、`stream/error` |
| `WS /api/events.host` | 下行单向 | host 级帧：会话创建/销毁、运行状态翻转、agent 失败 |

**信任围栏**（`dsh-client-connection/src/api-request-trust.ts`）：每请求必须 Host 为 loopback 或匹配 `trustedHosts`（DNS-rebinding 防御）；特权方法（`settings.*`、`credentials.*`、`host.pickDirectory`、`host.openPath`、`agentPreset.read/copy/openDocument/remove`、`llm.discoverModels`）**仅限 loopback**。浏览器 WebSocket 握手带 `Origin` 且须等于 Host 权威。`dsh web --host 0.0.0.0` 官方不支持（无认证层）。

### 2.2 RPC 方法域（`RpcMethodMap`，`packages/host/apiproxy/src/api/rpc-map.ts`）

- `session.*`：list / search / create / history / models / selectModel / rename / fork / prompt / attachment / updateQueue / cancel
- `workspace.*`：list / create / rename / delete / insertBefore / insertSessionBefore / archiveSession
- `subagent.*`：list / history / prompt / interrupt；`host.*`：describe / pickDirectory / listDirectory / createDirectory / openPath
- `settings.*`：describe / openDocument / update / replace / mutate；`credentials.*`：describe / set / unset
- `llm.*`：providers / models / discoverModels；`goal.*`：create / edit / pause / resume / complete / clear
- `skill.list`、`agentPreset.list/select/read/copy/openDocument/remove`

### 2.3 会话渲染数据

- 历史：`session.history` 分页拉取 `HistoryEntry = { event: SessionEvent, view?: ToolEventView }` + `SessionProjectionsBlock`（projection 基线，`asOfSeq` 与后续 `session/projection` 帧做 higher-seq-wins）
- 实时：mux 流 `session/event` 帧携带原始 `SessionEvent`（`@deepseek-ai/dsh-session/types`）+ host 计算的渲染意图 `ToolEventView`；`session/queue` 是完整暂存收件箱快照（排队/steer/上下文三种 placement）
- **注意**：官方把 `SessionEvent` 组装成对话视图的代码在 `dsh-client-runtime` 的 `ConversationNodeAssembler` + `ui-conversation`（11310 行）里——**独立前端必须自己实现事件 → 对话 UI 的组装**，这是最大的工作量
- `since` 续传钩子 v1 未实现：重连 = 重开流 + 重拉历史

### 2.4 可复用的官方浏览器侧代码（协议层，非 UI）

- `@deepseek-ai/dsh-host-apiproxy/api`：契约类型 + zod schema（浏览器直接 import）
- `@deepseek-ai/dsh-client-connection/client`：`AbstractApiClient` + `WebApiClient`（fetch + 双 WebSocket 下行实现），可原样复用或参考

## 3. 落地形态（本仓库插件格式）

### 3.1 profile 组合

把 `dsh-wui` 放进 profile bundle 栈，**替换** `@deepseek-ai/dsh-web-app`：

```jsonc
// ~/.dsh/profiles/<web>/package.json
"dsh": { "profile": { "bundles": [
  "@deepseek-ai/dsh-base",
  "@dsh-plugins/dsh-wui",   // 替代 @deepseek-ai/dsh-web-app
  // ...用户其他包
] } }
```

### 3.2 dsh-wui 的 `cordis.patch.yml`（host 组合层，自建 web 传输）

`dsh-web-app` 被移除后，以下行必须由 dsh-wui 自己 insert（并处理 dsh-web-app 原本对 base 行的禁用/覆盖，如 `tool-bash` 等移入 preset、`system-prompt` persona、`hmr` 等）：

- `web-startup`（或自带等价 provider：host/port/trustedHosts）
- `webserver`（`@deepseek-ai/dsh-host-webserver`，注入 `webStartup`）
- `api-gateway`（`@deepseek-ai/dsh-host-apiproxy`）
- `connection`（`@deepseek-ai/dsh-client-connection` node half：`/api` 路由 + 两条 WebSocket downlink）
- **自己的前端静态服务**：`frontend-static` fallback seat 是单座——不能与 web-app 共存；独立 app 用自己的 dist（`distIndex` 指向自建产物）注册 fallback，或自建 `register` 路由
- 可选：`agent-presets`、`session-query-sqlite`（`:memory:` 或按需）、`storage` 等 host 行按需保留

### 3.3 前端

- 完全自研：自己的 `index.html` + 构建产物（框架自选，官方参考是 React 18 + Vite；不依赖 `__DSH_BOOT__`、`dsh-client-web`、`dsh-client-ui-*` 任何东西）
- 协议客户端：直接 import `@deepseek-ai/dsh-host-apiproxy/api` 契约层（或复用 `WebApiClient`）
- 需要自己实现的 UI 域：会话列表/工作区、对话渲染（SessionEvent 组装）、输入框（prompt/steer/queue）、审批与提问浮层、工具调用卡片、设置/模型页（settings/credentials/llm）、子代理目录、任务/目标等（按需裁剪）

## 4. 工作量与风险

| 项 | 评估 |
| --- | --- |
| 传输层 | 低：契约层浏览器可导入，WebApiClient 可直接复用 |
| 会话/工作区管理 | 中：session.list/create/rename/fork + workspace.* + queue/jobs 快照 |
| **对话渲染** | **高：SessionEvent → 对话视图的组装 + markdown/工具卡片/流式更新（官方 ~11310 行）** |
| 设置/模型页 | 中：settings.* + credentials.* + llm.* 表单与 schema 渲染 |
| 审批/提问交互 | 中：mux 帧 server-request + POST /api/respond |
| 协议稳定性 | 中风险：rc.6 developer preview，可能有破坏性变更；契约层类型化可降低升级成本 |
| 信任围栏 | 低风险：loopback 开发无碍；特权方法本就 loopback-only |
| HMR/dev 工作流 | 需要自建（官方 dev:web 依赖 client-modules + dsh-client-hmr 机制，独立 app 不适用） |

## 5. 建议路线

1. **骨架**：包结构（`dsh.bundle.patch`）+ profile 替换 web-app + 自建 webserver/api/静态服务 → 打开页面能 `host.describe`
2. **传输**：`/api` unary client + 两条 WS downlink（复用契约层）→ 会话列表/工作区可读
3. **会话**：`session.history` + mux 实时帧 → 只读对话渲染
4. **交互**：`session.prompt`/queue/cancel + 审批/提问应答 → 可对话
5. **全量**：设置/模型、工具卡片、子代理、任务/目标等按需补齐

## 6. 备注

- 本仓库 `packages/` 下已存在空目录 `dsh-web-app/`（2026-08-16 22:17 创建，未跟踪）；用户消息中插件名为 `dsh-wui`，命名以用户确认为准。
- 动态 Cordis 插件（`cordis_define`）**不能**承担"完全替换"：它是进程内临时扩展，而独立 app 需要 host 组合层变更（bundle 栈、webserver、/api 路由），属于持久 profile 层面的仓库插件（bundle patch + 自建前端产物）。
