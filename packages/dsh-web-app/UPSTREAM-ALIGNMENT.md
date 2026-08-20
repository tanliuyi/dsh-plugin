# dsh-web-app Upstream Alignment

对比基线：`deepseek-ai/deepseek-harness` tag `dsh-v0.1.0-rc.8`（`141eb6fef83422698aef7a981029e843e8161534`），上游浏览器能力主要由 `packages/client/*` 与 `apps/web` 组成。独立前端继续使用 `@assistant-ui/react` 的 `AssistantRuntimeProvider`、`ThreadPrimitive`、`ComposerPrimitive`、`ThreadListPrimitive` 和 External Store Runtime；上游协议只作为传输和状态来源。

## 已对齐

- `/api` unary RPC envelope、`/api/respond`、mux/host 双 downlink 与自动重连。
- `host.describe`、session list/create/history/prompt/cancel/rename/fork、session attachments。
- assistant-ui Thread、ThreadList、Composer、Markdown、reasoning、附件、通用 tool fallback。
- `todo/write` 全表替换 projection（空数组隐藏计划条）、`turn/start` 清空且 `turn/end` 保留、composer 上方可折叠 TodoList 计划条，以及 `todo_write` 专用摘要行（支持并行 `in_progress`）。
- 多 step turn 的消息折叠：`assistant/message` 和 `tool/result` 不结束 running，只有 `turn/end` 或 host `session-status=false` 结束一轮；rc.8 取消流不再补最终 `assistant/message`，因此在 `turn/end` 冻结 chunk-only partial。
- tool error 状态、乱序 tool result 的兜底卡片、图片 attachment hydration。
- queue/jobs/projection 基线、queued message 删除/steer、goal CAS RPC（`goal.*`）。
- workspace 分组/平铺、排序、展开状态持久化、workspace 创建和 archive。
- session-specific model catalog/reasoning selection、agent preset list/select。
- approval/question pending UI、响应回传、plan projection chip、subagent history/prompt/interrupt 基础路由。
- settings 对话框：rc.8 四区段壳层（通用设置、模型、插件、Agent 预设）；通用设置通过 `settings.mutate`/`settings.update` 写入预设、权限、语言、外观和繁忙 Enter 行；插件页从 settings schema 生成类型化字段表单；模型页提供默认 provider/model/reasoning 表单，以及 provider 新增/自定义声明、凭据、Base URL、协议、模型发现/采用、模型目录和删除工作流；写入采用路径级 `settings.mutate` 和 `credentials.set`，并采用服务端返回的新 revision；支持 `settings.openDocument`。
- assistant-ui reload/refetch/edit/delete 回调已接入；delete 在 DSH 无独立 delete RPC 时按 archive 处理。

## 必须继续对齐的业务/协议能力

以下项目属于服务契约、状态同步或用户可执行工作流，不是单纯的视觉复刻：

- mux `session/subscribed.lastSeq`、projection watermark 和 reconnect baseline；当前重连后主要依赖刷新 session/history。
- queue 的 `edit` action，以及 queued、steering、context 三类消息的完整协议语义。
- workspace/session-added/order 等 host 事件的增量收敛，目前部分场景仍依赖 refresh baseline。
- DeepSeek 首次运行 onboarding，以及 credentials 的独立列举/清除管理界面（Provider 页已按引用接入 `describe/set/unset`）。
- agent preset authoring：read/copy/openDocument/remove。
- skills 的列举与主动调用、web search 的业务结果和引用数据、feedback protocol、schedule-after。
- produced files 的路径提取和 `host.openPath`，以及 session-log export/download。
- approval/question 的 replay、resolved 生命周期和 plan-review/access-confirmation 协议语义。

## 可选的 UI 层能力

这些是上游 `apps/web` 的展示或性能实现，不作为本独立前端的功能未对齐项；当前使用 assistant-ui 的通用能力即可满足产品契约：

- `session.history` 的分页策略、长历史虚拟化、滚动锚定和 trajectory virtualization。
- composer 几何、tab geometry、sidebar scrollbar gutter、conversation overflow 等布局契约。
- `HistoryEntry.view` 对应的 bash/diff/search/web/Cordis 专用卡片、code-mode nested call 展示、terminal abort row。
- subagent 活动树、专用侧栏层级、只读/continuable 的视觉呈现。
- session search 的分页、全文高亮和其他结果列表视觉细节。
- message feedback 按钮、turn-tail action 排布、produced-file chip 等具体组件形态；只有其背后的 RPC/业务语义需要时才纳入对齐。

## 本轮高风险修复

- 避免把每个 `assistant/message` 当成 turn 结束：上游一个 turn 可包含多个 step 和多次 assistant message。
- 只有 `turn/end`、host `session-status=false` 或当前 session 被移除时清除 `isRunning`。
- WebSocket downlink 同时兼容标准 `server-request` envelope 和兼容 carrier 的 raw frame；未知合法 frame 不再触发重连。
- tool result 保留 `isError/error`，结果先于 call 到达时仍显示工具卡片。
- 切换 session 时刷新 session-specific model catalog；队列操作使用 queue snapshot 对应 session，避免切会话后误操作。
