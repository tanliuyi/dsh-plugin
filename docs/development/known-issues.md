# 已知问题与上游缺陷记录

> 本文档记录 dsh-plugins 在实测中发现的缺陷：**已在本仓库修复**的插件级问题，
> 以及**根因在 dsh 核心（deepseek-ai/deepseek-harness）**、本仓库无法直接修复、
> 需要上游处理的上游缺陷。文档附带根因分析与修复建议，便于上游排期或后续
> 版本升级时核对。

## 1. ✅ 已修复：后台 subagents run 复用调用方 exec.signal（dsh-subagents 插件）

**状态**：已修复（commit 见 packages/dsh-subagents/src/runs/execution.ts），回归测试
见 packages/dsh-subagents/tests/background.test.ts。

**现象**：从工具调用（如 `run_code`）中启动**后台** subagents run（workflow 默认后台、
或 `async: true` 单 agent），run 在启动瞬间即被中止：

- workflow 后台：`workflow script aborted`（0s 失败）；
- `async: true` 单 agent：run 记录为 failed，但完成通知**误报 completed**
  （job 快照状态与 run 记录状态不一致）。

**根因**：`runInBackground`（packages/dsh-subagents/src/runs/execution.ts）把
`work(exec.signal)` 传给后台任务，而 `exec.signal` 是**工具调用方**的取消信号
（dsh 核心注入，绑定工具调用生命周期）：工具调用返回后该信号即被中止，后台 job
实际在返回后才执行，于是 run 启动即被取消。`services.ts` 的调度路径早已用
`new AbortController().signal` 绕开此问题，工具调用路径未同步修复。

**修复**：后台任务改为接收 `runInBackground` 内部独立 `AbortController` 的信号，
仅由 job cancel / 运行超时驱动中止；前台路径仍用 `exec.signal`。完成通知改为以

### 行为变更（消费方注意）

- **后台完成通知的状态来源变更**：旧实现以 job 快照状态为准（后台任务"未抛错"即报 `completed`，即使 run 实际失败）；新实现以 `run` 记录真实终态为准。依赖旧（错误）通知语义判断成功的消费方需改为以 `subagents({ action: "status" })` 的 run 记录为准——通知现在与 run 记录一致。
- **后台 run 的取消语义变更**：后台 run 不再随工具调用返回而中止（修复目标），仅在 job cancel / 运行超时 / 前台停止（`stop`）时中止。
- **runInBackground 签名变更**（内部函数，非公共 API）：`work` 回调从无参改为 `(signal: AbortSignal) => Promise<void>`；插件内两个调用点（单 agent 后台、workflow 后台）均已同步。
`run` 记录的真实终态为准（不再误报）。

## 2. ❌ 上游缺陷：fork 子代理模型上下文不包含父会话历史（dsh-agent / dsh-subagent-fork-in-process）

**状态**：根因在 dsh 核心，本仓库无法修复；以下为复现证据与修复建议。

**现象**：`subagent_fork`（以及 `subagents({ context: "fork" })`）创建的子代理
**看不到父会话的任何历史**——尽管工具描述声明 "a child agent seeded with all
completed turns so far"。实测（会话日志证据）：

- 子代理 Session header 含 `seedLength: 1652`、`parentSession`，父会话事件**完整
  回放**到子代理日志（含最早的 "这是什么项目？" 消息与 `session/end-seed` 标记）；
- 但子代理模型输入（turn 2 usage `inputTokens: 6024`）只含系统提示 + 当前消息，
  无任何历史消息；子代理自述"上下文几乎为空"。

**根因**：fork seed 仅用于**日志连续性**与**结果读取边界**（activationBoundary），
不进入模型输入。dsh-agent 的 `Inbox` 投影按
`session.events.slice(session.header.seedLength ?? 0)` 回放——**seed 部分的
`agent/inbox/spliced`（父会话消息）被完全跳过**；而模型输入由 inbox 驱动
（agent-loop 的 `messages: claimed`），故历史永不进入子代理上下文。

**上游修复建议**：fork seed 构造（`dsh-subagent-fork-in-process` 的
`completedTurnPrefix`）或 `Inbox` 投影需把 seed 中的父会话消息并入子代理模型
输入（例如 inbox 投影改为从 0 回放并只保留 pending 状态，或在 fork 时把父会话
surface 消息作为子代理初始上下文注入）。

**影响**：所有依赖 fork 上下文的任务（续写、评审、follow-up 分析）实际在
"无历史"状态下运行；调用方必须显式在 prompt 中携带所需上下文。

## 3. ✅ 已本地补丁：subagents 设置导航图标回退为齿轮（dsh 外壳硬编码）

**状态**：根因在 dsh web 外壳（`dsh-client-ui-settings-general`），插件侧无挂点；
本仓库提供幂等补丁脚本 `scripts/patch-web-settings-icon.mjs`（`pnpm patch:web-settings-icon`）
直接修改全局安装的 shell 客户端模块，**dsh 升级/重装后需重新运行**。

**现象**：设置面板左侧导航里「Subagents」分区显示通用齿轮图标（与 General 相同），
而不是智能体图标。

**根因**：外壳 `SettingsRoot.tsx` 的 `navIcon(id)` 只映射了
`models` / `agent-presets` / `plugins` 三个 id，其余（含 `subagents`）一律回退
`IconSettingsOutline16`。`settings.section` 的注册契约只有 `id`/`order`/`label`，
插件无法通过注册选项指定导航图标；`sidebar.settings` 为外壳独占 single 槽位
（替换即重写整个设置面板），故只能补丁外壳。

**修复**：在 `navIcon` 中为 `subagents` 增加分支，返回与 agent-presets 相同的
`IconAgentPresetOutline16`（产品图标集中唯一的智能体图标）。

**上游修复建议**：`settings.section` 注册选项增加可选 `icon`，或把 `navIcon`
改为按 id 的注册表（外壳提供默认回退），使分区图标成为插件可控能力。

## 4. ✅ 已修复：fork/continuable 子代理显式完成报告按父回合状态投递（dsh-subagent）

**状态**：**已完全修复**。本插件自有的显式回报路径——经插件级 `report` 工具 /
`reportFrom` 组合生成的、带**前缀 "Background subagent <id> reported:"** 的消息——
已按父回合状态动态选择投递，实测验证通过，不再排队为下回合消息。此路径由插件所有，
已与 dsh 核心自有的 settle 完成通知分离开（后者见第 5 节、仍为上游缺陷）。

**现象（修复前）**：显式回报生成的 "Background subagent <id> reported:" 消息未作为
注入消息进入当前回合上下文，而是作为**排队消息**出现，用户感知为"通知没送达"。

**验证证据（已复测通过）**：
- **旧 provider（dsh-base 原生注册的 @deepseek-ai/dsh-tool-subagent-report）**：报告的
  **下一回合（next-turn）** 才投递，仍落在排队路径，未进入当前回合；
- **重启后的插件替换实现**：目标消息在**下一 step（next-step）** 即送达到位，且 inbox
  中的对应待处理项被**认领 / 移除**，不再滞留排队。

**插件级实现（2026-08-16）**：本插件用子代理 `report` 工具（`src/report.ts`，经
`ctx.subagents.registerContinuableSetup` 注入每个 continuable 子作用域，作为
@deepseek-ai/dsh-tool-subagent-report 的插件级替代，子作用域注册、schema、guidance、
output 与 source 行为对齐上游）实现回合感知投递：
- **插件拥有 registerContinuableSetup**：子作用域级注入，插件持有该注册挂点；
- **直接父会话 header**：经直接父会话头（direct parent session header）定位直接父会话，
  据此判定父会话的回合状态；
- **回合感知投递**：调用 `ctx.subagents.reportFrom` 时，若直接父会话正处于活跃回合
  （SessionState 的 `turn/start` → `turn/end` 之间）选 `quiet`（回合内 inject，
  不另起唤醒回合）；否则选 `wakeup`（父已停靠，需唤醒一个新回合）；
- **内置 provider 由 Cordis 禁用**：`cordis.patch.yml` 同步禁用了 dsh-base 原生注册
  的 `tool-subagent-report` 行，避免重复注册；
- **HMR 回合状态水合**：热重载时正确重建当前回合状态（turn-state hydration），使回合
  判定在 HMR 之后仍准确。

**插件级补充（2026-08-15）：后台 run 完成通知的批量合并**。dsh-subagents 自己的后台
run（`runInBackground` 的 jobs 路径）已按上游 notify.ts 语义重写——completed 通知
按 completion-batcher 窗口（debounce 150ms / maxWait 1s）批量合并；父会话有活跃回合
时不注入（withhold + 日志，对齐上游 triggerTurn 只入 transcript）；空闲才 followup
唤醒；失败立即单独投递。

## 5. ❌ 上游缺陷：dsh 核心 notifySettlement 的完成通知投递（fork/continuable）

**状态**：根因在 dsh 核心，本仓库无法修复；以下为现象、风险与修复建议。

**现象**：核心 `notifySettlement` 生成的 settle 汇总（如 "Background subagent ...
finished and will do no further work ..."，或 stopped/failed 变体）——**不会生成
"reported:" 前缀**，由核心持有。当父 agent 处于 `idle` 时，核心以
`parent.followup(message)` 排队投递，等待下一个回合；父 agent 有活跃回合时才
`parent.steer(message)` 回合内注入。

**未解决风险**：**`agent.status` 在打开可持续（durable）回合期间可能显示为
`idle`**（例如工具调用间隙），此时通知会被误判走 followup 排队路径，留到
**下一回合（next-turn）** 才送达，而非当前回合内注入——正是已修复的显式回报路径在
修复前遇到的同类投递问题，但该路径属核心所有、本插件无挂点。

**已确认行为**：
- 若父 agent 真正空闲，排队 followup 符合预期（父确实停靠等待唤醒，下一回合送达合理）；
- 风险集中在"看似 idle、实际仍处于未关闭的 durable 回合"的中间态，此时应按回合内
  投递却走了排队。

**上游修复建议**：以"回合是否已打开"（如 `turn/start` 事件、持久回合生命周期）
而非 `agent.status` 判定注入时机，保证回合进行中的通知一律 `inject`/`steer`；
该核心路径无插件所有权挂点，需上游提供或开放 hook。

---

## 复现环境

- `@deepseek-ai/dsh@0.1.0-rc.6`（2026-08-15 实测）
- macOS / pnpm 10.32.1 / Node >= 20