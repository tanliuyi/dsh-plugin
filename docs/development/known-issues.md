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

## 3. ❌ 上游缺陷：fork/continuable 子代理完成通知投递为排队消息而非回合内注入（dsh-subagent）

**状态**：根因在 dsh 核心，本仓库无法修复。

**现象**：子代理 settle 后的完成报告（"Background subagent ... reported ..."）未作为
注入消息进入当前回合上下文，而是作为**排队消息**出现，用户感知为"通知没送达"。

**根因**：核心 `notifySettlement` 的投递判定：
`parent.status === "idle" → parent.followup(message)`（排队，等待下一个回合），
否则 `parent.steer(message)`（回合内注入）。当通知在父 agent 处于 idle（例如
工具调用间隙）时到达，即走排队路径；且部分投递路径（sendWaking）在父 agent 无
活跃 Activation 时会重复触发唤醒。

**上游修复建议**：以"回合是否已打开"（如 `turn/start` 事件）而非 `agent.status`
判定注入时机，保证回合进行中的通知一律 `inject`/\`steer`。

---

## 复现环境

- `@deepseek-ai/dsh@0.1.0-rc.6`（2026-08-15 实测）
- macOS / pnpm 10.32.1 / Node >= 20