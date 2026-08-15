# dsh 会话注入上下文机制研究

> 研究对象：`@deepseek-ai/dsh@0.1.0-rc.6`（2026-08-15，macOS）
> 目的：梳理"注入到模型上下文"的完整数据流，解释 fork 子代理上下文不可见、
> 完成通知排队投递等现象的机制成因。

## 1. 消息注入原语：inject / steer / followup

实现：`@deepseek-ai/dsh-agent-loop` 的 `Agent.send(message, target, wakeup)`。

| 原语 | target | wakeup | 语义 |
| --- | --- | --- | --- |
| `inject(msg)` | next-step | 否 | 回合内注入：仅当 agent 已在回合循环中时，下一个 step 边界可见；不唤醒 |
| `steer(msg)` | next-step | 是 | 注入 + 唤醒：空闲则开新回合，回合中则下个 step 边界处理 |
| `followup(msg)` | next-turn | 是 | 排队为新回合输入 + 唤醒（"排队消息"即此路径） |

每次注入持久化为 `agent/inbox/spliced` 事件（splice 操作日志）。`cancel` 可清空
inbox（`keepInbox` 除外）并中止当前回合。

## 2. Inbox 投影（dsh-agent）

`Inbox` 从会话事件重建待处理消息队列：

```js
for (const event of session.events.slice(session.header.seedLength ?? 0)) {
  if (event.type !== "agent/inbox/spliced") continue;
  this.apply(event.data);
}
```

**关键**：seed 部分（fork 继承的父会话事件）的 inbox splice 被跳过——子代理的
pending 队列只从自己的事件开始。

## 3. 回合组装与模型输入（dsh-agent-loop）

每 step（`turn() → preStep() → step()`）：

1. `claimed = inbox.claim(target, turn)` —— 取出待处理消息；
2. `systemPrompt.assemble()` —— 系统提示（含工具定义）；
3. `runtimeContext.project(joinContextSections(sections), sections)` ——
   运行时上下文快照；
4. `decision.messages = claimed + context`（可被 `agent/pre-step` 监听者修改）；
5. 模型请求 = `system + tools + session.deriveMessages() + claimed + context`；
6. decision.messages 落盘为 `user/message`（`surfaceOp: "append"`）。

**模型历史来源**：`deriveMessages()` = 折叠 `surface.nodes`（`user/message`、
`assistant/message`、`tool/result` 三类带 surfaceOp 的事件）。

## 4. 运行时上下文快照注入（"Current runtime context..."）

来源：`@deepseek-ai/dsh-system-prompt` 的
`joinContextSections()`：各子系统注册的 context section 拼接为
`Current runtime context. This snapshot supersedes earlier runtime-context snapshots.

<正文>`，
以 **user 角色消息**注入每个 step。

贡献者（`agent/pre-step` 监听者）：`dsh-sandbox-policy`（文件策略）、
`dsh-permission-presets`（权限预设）、`dsh-time-context`（时间）、
`dsh-tmux-context`（tmux 状态）、`dsh-tool-skill`（技能）、
`dsh-goal-round-driver`（goal）、`dsh-repeat-tool-reminder`（重复提醒）、
`dsh-plan-mode`（计划模式）、`dsh-compaction-basic`（压缩检查）等。

## 5. 会话事件持久化（dsh-session-persistence-jsonl）

- 追加时 `packChunkRuns(events)`：流式块（assistant/chunk 增量）打包为
  `reasoning-chunks` / `text-chunks` / `tool-call-chunks` 聚合行（seq 稀疏）；
- 读取时 `decodeStorageRecord` 展开恢复完整事件（seq 连续）；
- 会话 header 记录 `seedLength`（fork 谱系边界）、`parentSession` 等。

## 6. fork seed 机制（dsh-subagent-fork-in-process / dsh-subagent）

1. `completedTurnPrefix(parent)`：取父会话**最后一个 `turn/end` 之前**的全部事件
   （进行中的回合不继承）；
2. `seedDescriptorTurn(childId, seed, descriptor)`：追加 `subagent/descriptor`
   事件（模型隐藏的组成记录）与 `session/end-seed` 标记；
3. `sessions.prepare → Session.create(seed)`：seed 事件（含 surfaceOp）完整进入
   子 Session 的 surface。

**代码级验证**（用真实父会话日志 + dsh-session 模块复现全链路）：
`deriveMessages()` 返回 83 条历史消息（含"这是什么项目？"等）——
**代码层面历史应进入模型输入**。

## 7. 运行时实测结果（与代码不一致）

- 3 个 fork 子代理一致报告：模型输入只有系统提示 + 运行时上下文快照 + 当前消息，
  **看不到任何父会话历史**；
- **inputTokens 铁证**：spawn（无 seed）子代理 14585 tokens vs fork 子代理
  14208 tokens——**几乎相同**，fork 输入不含 seed 历史（若含 turn 1 的 ~12 条
  消息应多出 2-4k tokens）；
- 矛盾点：lib 代码路径（step → buildRequest → deriveMessages）看似完整，但运行时
  行为不符。**dsh 0.1.0-rc.6 的未决问题**——深层环节（如 LLM 适配层对消息的
  过滤、某处 seed surfaceOp 剥离、或非常规请求路径）需运行时 LLM 层日志定位。

**影响**：`subagent_fork` 与 `subagents({ context: "fork" })` 的"继承对话"
声明（"seeded with all completed turns"）在 0.1.0-rc.6 实际不成立；依赖 fork 的
续写/评审任务须显式携带上下文。

## 8. 完成通知投递（dsh-subagent notifySettlement）

```js
if (parent.status === "idle") parent.followup(message);  // 排队，等下一回合
else parent.steer(message);                              // 回合内注入
```

- `parent.status` 来自 agent-loop 的 phase（idle/maintenance → idle，其余 running）；
- 通知在父 agent 空闲（工具调用间隙）到达时走 followup → 表现为"排队消息"；
- 插件 `dsh-subagents` 的 run 通知使用自己的回合跟踪（`turn/start`-`turn/end`）
  判断 inject/followup，与核心机制相互独立。

## 9. 与 dsh-plugins 的关系

- `dsh-subagents` 插件的 `subagents` 工具后台 run 通知：插件自管
  （`deliverNotice` + `isTurnOpen`），已修复的通知状态问题见
  [known-issues.md](known-issues.md)；
- fork 上下文不可见（§7）与核心通知投递（§8）均为 dsh 核心行为，插件无法修复，
  详见 known-issues.md 的缺陷②③。
