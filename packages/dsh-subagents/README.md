# @dsh-plugins/dsh-subagents

[pi-subagents](https://github.com/nicobailon/pi-subagents)（pi coding agent 的 subagents 扩展，MIT）的 dsh 移植：让主会话把工作委派给专注的子代理。用于代码评审、侦察、实现、并行审计、保存的工作流、后台任务，以及任何受益于第二、三双模型眼睛的工作。

## 安装

```sh
# 本仓库内（本地路径）
dsh plugin --profile demo add ./packages/dsh-subagents

# 发布后（npm registry）
dsh plugin --profile demo add @dsh-plugins/dsh-subagents
```

安装后即可使用，无需创建 agent 或写配置。直接问：

```text
Use reviewer to review this diff.
```

```text
Ask oracle for a second opinion on my current plan. Challenge assumptions and tell me what I might be missing.
```

```text
Use scout to understand this code based on our discussion, then ask me clarification questions.
```

```text
Run parallel reviewers: one for correctness, one for tests, and one for unnecessary complexity.
```

主模型会决定是否调用 `subagents` 工具、用哪个 agent、如何组合工作。

## 工作原理

主会话是 parent。子代理是拥有独立任务和独立会话的 child（dsh 进程内原生子代理）。前台运行等待结果并返回；后台运行继续工作，稍后用 `status` 查看。

本插件把 pi-subagents 的编排面移植到 dsh 的原生子代理能力（`ctx.subagents` / `ctx.agents`）之上：内置 agents、`subagents` 工具（委派/工作流/管理动作）、missions、schedules、supervisor 通道（intercom）、watchdog、goal 驱动、slash 命令与技能。

> 工具名用 **`subagents`**（复数）：dsh 的 standard agent preset 已注册原生的 `subagent` / `subagent_fork` 工具，名称冲突时同一层注册会抛错。原生 `subagent` 工具保留原始委派；本插件的 `subagents` 工具提供 pi 风格的 agent 目录、动作面、missions、schedules 与 watchdog。

## Minimal 预设

DSH 的 `minimal` 预设承诺只向模型提供持久 `bash` 与 `str_replace_editor`。本插件虽然挂载在 host plane，但会在 live minimal agent 的 scope 中移除 `subagents`、`contact_supervisor`、`subagents_supervisor` 与 `subagents_wait`；空白会话在首次回合前切换 preset 时会同步安装或撤销限制。missions、schedules、Web 设置等 host 服务仍常驻，不进入 minimal 的模型工具面。

DSH 当前的 command/skill registry 是 host-global，尚无 preset-scoped 可见性 API，因此 slash command 和 skill 名称仍可能出现在 UI 清单中；这不使对应模型工具在 minimal 中可用。

## 内置 agents

| Agent | 用途 |
| --- | --- |
| `scout` | 快速代码库侦察：相关文件、入口、数据流、风险。 |
| `researcher` | 网络/文档调研，带来源与简明研究简报（需要 `web_search`/`web_fetch` 可用）。 |
| `worker` | 实现工作：编辑文件、验证、未批准的决策上报而不是猜测。 |
| `reviewer` | 对照任务/计划做代码评审与小修复：正确性、测试、边界、简洁性。 |
| `oracle` | 行动前的第二意见：挑战假设、发现漂移，不编辑文件（别名 `advisor`）。 |
| `delegate` | 轻量通用委派，行为接近父会话。 |

经验法则：`scout` 在理解代码之前，`researcher` 在相信外部事实之前，`worker` 负责实现，`reviewer` 负责检查，`oracle` 在决策本身有风险时。

## 常用工作流

| 想要 | 自然表达 |
| --- | --- |
| 第二意见 | "Ask oracle to review this plan and challenge assumptions." |
| 评审 diff | "Use reviewer to review this diff." |
| 并行评审 | "Run reviewers for correctness, tests, and cleanup." |
| 实现后评审 | "Implement this, then review it." |
| 评审循环 | "Run a review loop on this change with a max of 3 rounds." |
| 后台运行 | "Run this in the background." |
| 浏览 agents | "Show me the available subagents." |
| 查看运行中工作 | "Show active async runs." |
| 检查配置 | "Check whether subagents are configured correctly." |

推荐实现循环：`clarify → scout → worker → fresh reviewers → worker`。打包的提示词快捷方式 `/parallel-review`、`/review-loop`、`/parallel-research`、`/gather-context-and-clarify`、`/parallel-cleanup` 让这些模式可重复使用。

## 使用方法

### 单个子代理

```js
subagents({ agent: "scout", task: "Analyze the auth flow" })
```

省略 `agent` 时由路由选择（LLM 优先，关键词启发式兜底）。`context: "fork"` 让子代理继承本对话已完成回合（worker/oracle 默认 fork）；`context: "fresh"` 是独立子代理。

### 脚本化工作流（workflowScript）

```js
subagents({ workflowScript: `
  const scan = await runs.run("scan", { agent: "scout", task: "Analyze auth" });
  const reviews = await runs.all([
    { key: "correctness", agent: "reviewer", task: "Review correctness: " + scan.output },
    { key: "tests", agent: "reviewer", task: "Review tests: " + scan.output }
  ]);
  return reviews.map(result => result.output);
` })
```

- `runs.run(key, { agent, task, context?, gate?, acceptance? })`、`runs.all([...])`（并行波）。
- `await state.get(key)` / `state.set(key, value)` —— 经 enclosing mission 的持久 JSON 状态（256 KiB 上限）。
- `await prompts.render("package:<name>" | "user:<name>" | "project:<name>", vars?)` —— 渲染提示词模板。
- 工作流默认后台运行（`async: false` 前台等待）。普通工作流自动创建一个 enclosing mission，结果以 `Mission: <id> (<status>)` 结尾；`mission: false` 表示一次性工作流。

### 管理动作

```js
subagents({ action: "list" })
subagents({ action: "status" })
subagents({ action: "status", view: "fleet" })
subagents({ action: "status", id: "<run-id>", view: "transcript", lines: 80 })
subagents({ action: "interrupt", id: "<run-id>" })
subagents({ action: "stop", id: "<run-id>" })
subagents({ action: "steer", id: "<run-id>", message: "checkpoint after the current tool" })
subagents({ action: "resume", id: "<retained-run-id>", message: "continue and improve the current-scope change" })
subagents({ action: "children.list" })
subagents({ action: "doctor" })
subagents({ action: "guide", topic: "workflows" })
subagents({ action: "mission.create", mission: { title: "Ship auth refresh", objective: "...", goal: true, budget: { tokens: 400000 } } })
subagents({ action: "schedule.create", id: "backlog", every: "6h", workflowScript: "..." })
subagents({ action: "watchdog.configure", model: "recommended", scope: "session" })
subagents({ action: "grant-spawn-budget", additional: 10 })
```

完整参数与动作参考见 [docs/tool-reference.md](docs/tool-reference.md)（也可用 `guide` 动作或 `/subagents-guide` 查看）。

### Supervisor 通道（子代理问父会话）

子代理被阻塞或需要决策时调用 `contact_supervisor`（`reason: "need_decision" | "interview_request" | "progress_update"`）；父会话用 `subagents_supervisor`（`{ action: "reply", replyTo, message }` 或 `{ action: "pending" }`）查看/回复。请求按精确父会话隔离。

### 子代理反向回报（continuable 子代理的 `report` 工具）

本插件为每个 continuable 子代理注入反向回报通道：子代理用 `report` 工具把结果
/进展发回启动它的父会话（子作用域注册、schema、guidance、output 与 source 行为对齐
dsh 官方 tool-subagent-report，作为其插件级替代）。投递按直接父会话回合状态动态选择：
父回合开着 → `quiet`（回合内注入，不排队）；父已停靠 → `wakeup`（唤醒一个新回合）。
父会话回合状态在插件 apply/热重载时从各存活会话的事件日志折叠重建（最近 `turn/start`
即判为进行中），故重载瞬间已有开回合的父会话不会被误判为停靠。
配装时 `cordis.patch.yml` 会禁用它替换的原生 `tool-subagent-report` 行。

### Watchdog（可选对抗性评审）

`subagents({ action: "watchdog.configure", model: "recommended" })` 或 `/subagents-watchdog on` 开启。在每个回合边界，若 agent 改变了仓库状态，用配置的强模型评审 diff；阻断项作为可见消息送达，`autoFollow` 可自动排队修复指令。范围监控（scope drift）与每 N 次工具调用的 cadence 评审可选。

## 配置

插件配置（profile 的 `cordis.patch.yml` 覆盖层）：

```yaml
- id: subagents
  name: '@dsh-plugins/dsh-subagents'
  config:
    timeoutMs: 3600000
    maxSubagentSpawnsPerRun: 64
    maxSubagentDepth: 2
    missions:
      enabled: true
      retainTerminal: 200
    watchdog:
      enabled: false
      main:
        model: anthropic/claude-opus-4-8
        thinking: high
    agentOverrides:
      reviewer:
        description: Independent review tier
```

全部键见 [docs/configuration.md](docs/configuration.md)。常用键：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `asyncByDefault` | `true` | workflowScript 缺省后台。 |
| `timeoutMs` | 30 分钟 | 运行级默认时限。 |
| `gateTimeoutMs` | `120000` | `gate` 验证命令的执行超时（毫秒）。 |
| `maxSubagentSpawnsPerRun` | `64` | 单次运行树累计子代理上限。 |
| `maxSubagentSpawnsPerSession` | 无限 | 会话累计启动上限（`grant-spawn-budget` 可追加）。 |
| `maxActiveAsyncRunsPerSession` | 无限 | 并发顶层后台运行上限。 |
| `maxSubagentDepth` | `2` | 嵌套委派深度上限。 |
| `defaultModel` / `defaultThinking` | — | 子代理默认模型/思考级别。 |
| `agentOverrides` | `{}` | 按 agent 覆盖（模型/提示词/工具/禁用等）。 |
| `missions.*` | 开 | mission 存储配置。 |
| `scheduledRuns.*` | 开 | 持久调度配置。 |
| `intercomBridge.mode` | `always` | 子代理协调指令（`always`/`fork-only`/`off`）。 |
| `watchdog.*` | 关 | 对抗性评审配置。 |
| `permissions.rules` | `{}` | 子代理工具 `allow`/`ask`/`deny` 规则（`ask` 在 dsh 端口降级为 `deny`）。 |

模型 id 使用 pi 风格（`provider/model[:thinking]`，如 `anthropic/claude-sonnet-4:high`），按 dsh 注册的 adapter 目录模糊解析；未解析的模型回退为继承父会话模型。

## Web 设置页（Web UI）

在 dsh Web UI 中，本插件注册「设置 → Subagents」分区（client 插件：`package.json` 的 `dsh` 对象下声明 `client` 字段，即 `dsh.client`，并提供 `exports["./client"]`），可在浏览器里编辑上述常用键，无需手写 `cordis.patch.yml`。

- **传输**：浏览器端表单经同源路由 `/api/subagents/settings`（GET/PUT/DELETE）读写覆盖文件 `~/.dsh/subagents/web-settings.json`。该路由挂在 webServer 上（exact 路由，优先于 api-proxy 的 `/api` 前缀），自带回环信任校验（实际 TCP 对端与 Host 必须是回环地址；写请求必须携带同源 Origin——CSRF 关键约束；拒绝 cross-site 请求）。
- **为什么不用 Host settings API**：dsh 的 settings RPC 命名空间是 api-proxy 白名单（`WEB_SETTINGS_NAMESPACES`），第三方插件命名空间只会得到 `settings-not-exposed`，因此本插件自带传输。
- **生效方式**：除 `missions.enabled` 与 `scheduledRuns.enabled`（apply 期固定结构，标「重启后生效」）外，保存即 live-apply——消费点（spawn、watchdog、budgets 等）在调用时读取 `deps.config`，下一次工具调用即生效。
- **文件即覆盖层**：web-settings.json 只存与 cordis 配置（baseline）不同的键；「恢复全部默认」会清空文件并把内存配置复位。文件损坏时按空覆盖处理，不影响插件启动。
- **限制**：非回环（LAN）部署暂不支持该设置页（信任校验只认回环，fail-closed）；经反向代理暴露时代理必须保留原始回环 Host 头才会被接受，**不应**把该路由代理给不可信来源（如确需经代理访问，代理自身必须加认证/访问控制，且仍无法通过信任校验——本设置页只设计给本机浏览器）；设置页只覆盖上述常用键，`agentOverrides`、`permissions.rules` 等复杂结构请继续用配置文件。
- **零配置（dsh rc.6）**：client bundle 扫描器（dsh-client-modules）经 loader 的 `baseUrl`（profile 目录）解析包清单，因此 profile 安装的包只要导出 `./package.json` 就会被原生发现，无需任何环境变量（实测 client bundle 200 + 启动清单含本包）。本插件另在 apply 时自注册 `clientModules` 表行作为兜底，未来 dsh 版本若调整扫描机制仍可工作。

## Agent 自定义

Agent 是带 YAML frontmatter 的 markdown 文件，按优先级 project > user > builtin：

| 作用域 | 路径 |
| --- | --- |
| 内置 | 本包 `agents/` |
| 用户 | `~/.dsh/subagents/agents/**/*.md` |
| 项目 | `<root>/.dsh/subagents/agents/**/*.md`（root = 最近的 `.dsh` 或 `.git` 目录） |

```yaml
---
name: security-reviewer
description: Security-focused review
tools: read, grep, glob, bash
thinking: high
---
You are a security reviewer...
```

管理动作 `create`/`update`/`delete`/`eject`/`disable`/`enable`/`reset`、refine 覆盖层与 `memory` 见 [docs/agents.md](docs/agents.md)。

## 开发

```sh
pnpm build   # tsc → lib/
pnpm test    # node:test + tsx（102 个用例）
```

## 与本仓库其它文档

- [docs/agents.md](docs/agents.md) — agent 定义与 frontmatter 参考
- [docs/workflows.md](docs/workflows.md) — workflowScript 与提示词快捷方式
- [docs/missions.md](docs/missions.md) — missions 与 schedules
- [docs/observability.md](docs/observability.md) — status/fleet/产物
- [docs/tool-reference.md](docs/tool-reference.md) — `subagents` 工具全参数
- [docs/configuration.md](docs/configuration.md) — 全部配置键
- [docs/models.md](docs/models.md) — 模型解析与覆盖
- [docs/watchdog.md](docs/watchdog.md) — watchdog 与子代理权限
- [docs/extension-api.md](docs/extension-api.md) — 扩展缝（preflight 等）

## 与 pi-subagents 的差异（dsh 移植说明）

- 工具名 `subagents`（原生 `subagent` 名称已被 dsh preset 占用）。
- 子代理是 dsh 进程内原生 child（`ctx.subagents.start`），不是 `pi` CLI 子进程；`resume` 优先续跑原 child 会话（`subagents.followup`，保留中断回合的完整状态），child 不可用时回退为带先前输出的 fallback challenge。
- 预算语义（与上游的差异如实声明）：上游在子代理内硬强制 `toolTimeoutMs`（per-tool 定时器）、`turnBudget`（回合数硬中止）与链级 `usageBudget`（workflow 跨子代理费用门）；dsh 侧 `turnBudget` 已移植（persona 注入软预算 + 全局 turn/start 事件计数，soft 到达 maxTurns 时 steer 请求 wrap-up、超过 maxTurns+graceTurns 时 cancel 中止，对齐上游 turn-budget.ts）；`toolBudget` 已移植计数与 soft/hard 提示（soft nudge、hard 后 block 工具 steer 告知禁止；dsh 无 per-tool 拦截，无法真正阻止调用）；`toolTimeoutMs` 已移植 per-tool 计时中止（超时 cancel；wait 类工具豁免；仅显式配置生效，上游默认 fast-tool 超时未采用——dsh-agent 自身管理工具执行）；链级 `usageBudget.tokens.hard` 门已实现（tokenMeter 启发式估算；`costUsd` 记录不执行）；`completionGuard` 已移植（task-intent 纯函数 + 全局 tool/call 事件观察写工具，替代上游消息流检测；实现类任务完成但从未编辑 → 失败）；`structuredOutputSchema` 已接线（透传 dsh 平台原生 outputSchema，结果在 result.structured/structuredOutput）；`permissions.rules.deny` 已接线（→ toolFilter.deny 排除；`ask` 无 per-tool 审批钩子不执行）；`share`、`worktree`、chains、Herdr/Orca 集成、外部 CLI profiles 未移植（见 [docs/tool-reference.md](docs/tool-reference.md) 与 [docs/workflows.md](docs/workflows.md)）。watchdog 的 LSP 预检已移植（自包含 typescript-language-server 子进程），见 [docs/watchdog.md](docs/watchdog.md)。
- 模型/thinking 解析为 dsh adapter 目录的匹配；`fallbackModels` 已接线驱动重试（primary + fallbacks 候选列表，可重试模型失败——rate limit/模型不可用/网络——时换下一个候选重跑任务，对齐上游 model-fallback.ts）。watchdog 评审模型按上游语义严格解析到已注册 provider + 已发现模型（见 [docs/watchdog.md](docs/watchdog.md)）。
- 其余行为对齐 pi-subagents（HEAD 47552b5）：agents frontmatter、验收门（acceptance/gate，推断语义经 task-intent 对齐上游 inferLevel）、预算（turn-budget/tool-budget/tool-timeout 运行期强制，见上）、missions（含 goal 驱动与 state，mission.update/attach-run/close 支持上游 missionUpdate/missionStatus/runMode/runStatus 参数面）、schedules（含 catchUp）、supervisor 通道、**watchdog 完整移植**（agent_end 边界评审、turn-delta 评审输入、只读评审 agent + 结构化警告 + emission guard、多层 settings、child 独立 runtime、cadence steer、auto-follow、LSP 预检、session override 与完整命令面，见 [docs/watchdog.md](docs/watchdog.md)）、refine 覆盖层、slash 命令、debug.run 生命周期诊断、workflow 沙箱（禁用 codeGeneration、emit、JSON 断言）。
- 未移植（dsh 平台无对应能力，如实记录）：`worktree`（child 无独立 cwd）、`chains`（append-step/approve-checkpoint/reject-checkpoint 依赖上游 durable chain 架构）、`inspector.*`/`project.*`（Herdr 桌面集成）、`worktree.discard`、`steeringRecovery`（依赖进程恢复描述符）、resume 的持久化契约恢复（进程重启后保留 child 需重新 launch）、MCP direct tools（dsh 无 MCP 服务器面）、`share`（无 Gist）、`permissions.ask`（无 per-tool 交互审批）、`costUsd`（无费用数据）、`chatProgress`（无 live-card 投影）。
