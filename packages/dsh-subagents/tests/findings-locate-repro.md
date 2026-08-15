# dsh-subagents 四项发现：源码定位与真实复现

- 时间：2026-08-15（第二轮矩阵测试之后）
- 对象：`@dsh-plugins/dsh-subagents` v0.1.0 当前会话已加载实例（src 源码与 lib 构建产物一致）
- 方法：源码阅读定位 + 当前会话真实调用复现（全部真实执行，非 mock）
- 结论：**4 项发现全部定位到具体代码路径，且全部复现成功（#N1 为确定性复现）**

---

## #N1（严重，偶发→已确定性复现）workflow 异常路径悬挂：run 永不终结 + mission 残留 active

### 源码定位

**悬挂主因：`runs/execution.ts` `launchWorkflow` 的 `execute()`（L380-404）没有 catch。**

```ts
const execute = async (signal: AbortSignal) => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(...), timeoutMs)
  try {
    const result = await runWorkflowScript({ ... signal: AbortSignal.any([signal, controller.signal]) })
    const failed = run.children.some((child) => child.status !== 'completed')
    store.finishRun(run.id, failed ? 'failed' : 'completed', ...)   // L397
    await ...missions.updateRunStatus(run.missionId, run.id, run.state)  // L398
    await finalizeAutoMission(deps, run, projectRoot, ...)         // L399
    return result
  } finally {
    clearTimer()   // 只有 finally！reject 时 L397-399 全部跳过
  }
}
```

- `runWorkflowScript`（`runs/workflow.ts` L227-312）在两种情况下 reject：
  1. **脚本/lane 抛错**：`runs.all` = `Promise.all(items.map(onSpawn))`（L259-261），任一个 `onSpawn` reject（如 `runs/workflow.ts` L345 `resolveWorkflowAgent` 返回 undefined 时 throw；或 `runs/spawn.ts` L145-156 预算/深度超限 throw）→ 整个脚本 promise reject。
  2. **信号中止**：`runs/workflow.ts` L291-299 的 `abortPromise`（超时 `controller.abort` 或调用方 `exec.signal` abort）。
- `execute()` reject 后：L397 `finishRun` / L398 `updateRunStatus` / L399 `finalizeAutoMission` **全部不执行** → run 记录永留 `running`、auto mission 永留 `active`。
- reject 冒泡到 `runInBackground` 的 `work()`（L129-138）→ job 状态 `failed` → 插件投递 `[subagents] background run ... failed` 通知。**这就是"收到 failed 通知但 status 一直 running"的完整解释**（第一轮 G2 的现象）。
- 后台路径（L408-410）`execute(exec.signal)` 直接复用调用方工具信号，`exec.signal` 中止时机由 dsh 控制 → 偶发性来源；前台路径（L421）reject 时虽有 catch（L422-427）会 finishRun，但**前台 catch 里只标 `failed` 且同样存在未终结风险**（L423-425 有 finishRun/finalize，前台路径是完整的）。

**mission 残留次因：`runs/control.ts` `stopRun`（L36-55）只 `store.finishRun('stopped')`，不调用 `missions.updateRunStatus` / `finalizeAutoMission`。**

```ts
store.finishRun(run.id, 'stopped', { stopReason: 'stopped by parent' })  // L52 —— 到此为止
```

对悬挂 workflow：children 早已全部结束（无 active child），stop 只改 run 状态；run 终结的 mission 更新完全依赖 child 状态回调，而该回调在悬挂路径上不会触发 → mission 残留 `active`（实测 `1e503924-c37`、`4fe80a85-679`）。对比：interrupt/stop 正常单子代理时 child 的 cancel 会触发 `launchSingle` 收尾回调（`execution.ts` L287-288）→ mission 正常终结，所以只有悬挂路径受害。

### 复现（确定性）

1. 后台 workflow，`runs.all` 中一个 lane 使用不存在的 agent：
   ```js
   const results = await runs.all([
     { key: "ok", agent: "delegate", task: "Reply with exactly: lane-ok" },
     { key: "bad", agent: "no-such-agent-xyz", task: "boom" }
   ]);
   ```
2. 结果（真实调用）：`started background workflow da71b2e2-235 · ok, bad` → 数秒后收到 `[subagents] background run da71b2e2-235 (workflow) failed` 通知 → `status` 显示 `da71b2e2-235 · workflow · running · 4m 21s`（**job failed 但 run 悬挂**）→ `mission.list` 显示 `4fe80a85-679 active workflow`。
3. `stop da71b2e2-235` → run 变 `stopped`，**mission 仍 `active`**（需手动 `mission.close`）。

### 修复建议

- `execute()` 增加 catch：reject 时 `store.finishRun(run.id, 'failed', { stopReason })` + `updateRunStatus('failed')` + `finalizeAutoMission('failed')`，与前台 catch（L422-427）对齐。
- `stopRun` 终结时同步 `updateRunStatus(run.missionId, run.id, 'stopped')` + `finalizeAutoMission(..., 'failed')`（mission 无 stopped 态则归 failed）。

---

## #N2（严重）supervisor 等待期 run 被提前终结：回合结束 ≠ 任务结束

### 源码定位

链条（`runs/spawn.ts` + `runs/execution.ts` + `intercom/supervisor.ts`）：

1. worker 投递决策请求：`contact_supervisor` → `SupervisorChannel.ask()`（`intercom/supervisor.ts` L44-79）入队 + `deliverNotice(parentAgent, ...)` 通知父会话。**子代理随后主动结束回合等待回复**——这是 intercom 协议的正常形态。
2. 子代理回合结束 → `ctx.subagents.start` 返回的 `runHandle.result` resolve（`runs/spawn.ts` L245）→ `spawnChild` 把它当作**任务完成**：定稿 child（L291-303 `completed`）→ **`await runHandle.dispose()`（L311）** → `store.finishChild`（L318）返回。
3. `launchSingle` 收尾（`execution.ts` L287-288）：`updateRunStatus(..., 'completed')` + `finalizeAutoMission('completed')` → **run 与 auto mission 立即 terminal**——而任务其实只完成了一半（在等父决策）。
4. 父会话回复：`SupervisorChannel.reply()`（L87-105）→ `deliverNotice(childAgent, ...)`（L95-98）→ `deliver.ts` 见 `agent.status !== 'running'` 走 **`agent.followup(message)`**（L21）——但该 agent 已被步骤 2 的 `dispose()` 销毁，followup 无法唤醒/无法恢复 → **决策丢失，任务永不继续**（仅当 child 仍在线时 reply 才有效，与实测"两次 reply 才落盘"的第一轮观察同源）。

### 复现（完整闭环）

1. worker 任务：`contact_supervisor(need_decision)` 询问写 x 还是 y，然后**立即结束回合**（输出 `awaiting-parent-decision`）。
2. 真实结果：工具返回 `✓ worker · completed`，`mission.list` 显示 mission `f3ee1c4f-48c completed` —— **run/mission 在等待决策期间已被终结**。
3. 父会话 `subagents_supervisor reply`（replyTo `3687325f`）→ 返回 `Reply delivered`，但 15s 后检查目标文件：**未写入**（worker 未恢复）。
4. 仅当父会话再 `resume` 该 retained child 补发决策，worker 才恢复执行并落盘（`x`）。

### 修复建议

- `spawnChild` 完成定稿前检查该 child 是否有 pending supervisor 请求（`SupervisorChannel.pending(childSessionId)` 非空）→ 若在等回复：**不终结 run/mission、不 dispose**，转为"等待中"态。
- `SupervisorChannel.reply()` 命中等待中 child 时，用 `agent.steer`/`inject`（而非 followup）唤醒。
- 兜底：reply 投递失败/无在线 agent 时已走 `replyQueues` 暂存（L100-104），但取回点 `takeQueuedReplies` 只在 resume 时消费——可在 reply 时若 child 在线但已终结则自动触发恢复。

---

## #N3（中）resume 产生重复 run 记录（幽灵 run 永不终结）

### 源码定位

**双重 createRun：**

- `runs/execution.ts` `launchResume`（L452-471）：
  ```ts
  const run = store.createRun({ mode: 'single', agent: retained.agent, goal: `resume ${retained.agent}`, missionId: retained.missionId })  // L462 —— run A
  const child = await resumeChild({...}, retained, params.message ?? '...', {...})  // L463
  const details = store.detailsOf(run)  // L469
  return { text: child.text, details }
  ```
  run A **从不调用 finishRun**。
- `runs/control.ts` `resumeChild`（L89-127）：
  ```ts
  const run = deps.store.createRun({ mode: 'single', agent: agent.name, missionId: retained.missionId })  // L109 —— run B
  const child = await spawnChild(...)
  deps.store.finishRun(run.id, ...)  // L121 —— 只 finish run B
  ```
- 结果：每次 resume 产生两个 run 记录——run A（launchResume 创建，`running` 永不终结）与 run B（resumeChild 创建，正常 terminal）。run A 的 `localAgent` 为空、无 children，`stop` 显示 `0 active child(ren) cancelled`。

### 复现

1. `resume {resume: <retained-id>, message}`（真实调用，2 次）。
2. `status` 结果（真实调用）：每次 resume 后列表出现**成对记录**——`a2bf6ff2-3e9 · worker · completed` + `c580152b-234 · worker · running`；前一轮的幽灵 `f7e0dbc6-c3b · worker · running · 6m 44s` 仍未终结。两个幽灵 run 均需手动 `stop`。

### 修复建议

- `launchResume` 删除 L462 的 `createRun`，让 `resumeChild` 创建并返回 run（或 `resumeChild` 接受外部 run 并复用之）；`detailsOf` 改从 resumeChild 返回值取。
- 或在 `resumeChild` 成功后对 run A 补 `finishRun`（治标）。

---

## #N4（低）disable/enable 的 scope 定位与 update/delete 不一致

### 源码定位

`runs/management-actions.ts`：

- L58：`scope` 变量默认 `'user'`，仅在 `params.agentScope === 'project'` 或 config 带 scope 时才是 project。
- **disable/enable（L136-143）**：`resolveManagementTarget(scope, projectRoot, deps.home)` —— 用默认 `scope`，**从不按 agent 实际 scope 解析**。
- **update（L109）**：`resolveManagementTarget(resolved.agent.scope === 'user' ? 'user' : 'project', ...)` —— 按 agent 实际 scope。
- **delete（L120）**：`deleteScope = resolved.agent?.scope === 'project' ? 'project' : 'user'` —— 按 agent 实际 scope。
- `agents/registry.ts` L250-251 `scopeDataDir`：user = `~/ .dsh/subagents/`（全局），project = `<projectRoot>/.dsh/subagents/`。

### 复现

1. `create` project 作用域 agent `proj-disable-probe`（真实调用）→ 写入 `/Users/tanliuyi/projects/dsh-plugins/.dsh/subagents/agents/proj-disable-probe.md`。
2. `disable proj-disable-probe` → 返回 `disabled agent proj-disable-probe in user scope`。
3. 文件证据（真实检查）：
   - `~/.dsh/subagents/overrides.json` = `{"agents": {"proj-disable-probe": {"disabled": true}}}` ← **全局 user 层被写入**
   - `<cwd>/.dsh/subagents/overrides.json` = 不存在 ← project 层无痕
4. 影响：disabled 标记是**按名字全局生效**的（registry 合并 user overrides 时对任何项目的同名 agent 生效）→ 另一个项目若也有同名 agent 会被误禁。附加观察：`enable` 只移除 `disabled` 键，留下 `{"proj-disable-probe": {}}` 空条目残留。

### 修复建议

- disable/enable 与 update/delete 对齐：先 `registry.resolve(params.agent, 'both', projectRoot)`，按 `resolved.agent.scope` 决定 target（builtin 时禁用走 user overrides 的现有语义保留）。
- `setAgentDisabled` 移除标记时若条目为空对象则删除整个条目，避免残留。

---

## 复现清理记录

- `da71b2e2-235`（#N1）、`c580152b-234` / `f7e0dbc6-c3b`（#N3 幽灵）均已 `stop`
- 悬挂 mission `4fe80a85-679`（#N1）已 `mission.close`
- `tests/.matrix-tmp/`（#N2 的 n2-repro.txt）已删除
- `proj-disable-probe` agent 已删除；`~/.dsh/subagents/overrides.json` 恢复 `{"agents":{}}`
- 仓库内 `.dsh` 空目录结构已清理
- 当前无 active run、无 active mission（doctor 复查确认）

## 修复优先级建议

| 缺陷 | 严重度 | 修复点 | 优先级 |
| --- | --- | --- | --- |
| #N1 workflow 异常悬挂 + stop 后 mission 残留 | 严重 | `execute()` 加 catch；`stopRun` 补 mission 终结 | P0 |
| #N2 supervisor 等待期 run 被终结 | 严重 | spawnChild 定稿前检查 pending supervisor 请求；reply 唤醒在线的等待 child | P0 |
| #N3 resume 幽灵 run | 中 | 去掉 launchResume 的重复 createRun | P1 |
| #N4 disable/enable scope 不一致 | 低 | 按 resolved.agent.scope 定位 | P2 |

---

## 七、修复记录（2026-08-15，定位后同轮完成）

4 项发现全部修复。`pnpm build` + `pnpm test`（108 用例，新增 6 个）全绿。

| # | 修复 | 改动 |
| --- | --- | --- |
| N1 | workflow reject 兜底终结 + stop 补 mission 终结 | `runs/execution.ts`：`execute()` 增 catch（reject 时 `finishRun('failed')` + `updateRunStatus('failed')` + `finalizeAutoMission('failed')` 后继续上抛，保留 job failed 通知）；`dispatchAction` stop 分支在 `stopRun` 后对 `missionId` 补 `updateRunStatus('stopped')` + `finalizeAutoMission('failed')` |
| N2 | supervisor 等待期 run 不再提前终结 | `runs/spawn.ts`：`SpawnDeps` 注入 `supervisor`；`spawnChild` 在 result settle 后检查 `supervisor.pending(childSessionId)`——有未答复请求时**不 dispose、不终结**，标记 `awaitingSupervisor` 并 `waitForSupervisorResolution`（监听 `agent/status` idle + pending 清空 → resolved；`agent/disposed` → stopped；超时 → failed），醒后从 child session 的 `deriveMessages()` 收集最终输出；`types.ts` `ChildRecord.awaitingSupervisor`；`runs/status.ts` child 行显示 `awaiting supervisor reply` |
| N3 | resume 不再产生幽灵 run | `runs/execution.ts` `launchResume`：删除重复 `createRun`，run 记录与 details 全部取自 `resumeChild` 创建的 run（按返回 `runId` 查找） |
| N4 | disable/enable 按实际 scope + 空条目清理 | `runs/management-actions.ts`：disable/enable 先 `registry.resolve` 按 `resolved.agent.scope` 定位 target（builtin → user overrides）；`agents/management.ts` `setAgentDisabled`：enable 后条目为空时整个删除（此前"删了又放回"残留 `{}` 占位） |

新增测试：`tests/spawn.test.ts`（waitForSupervisorResolution 三态：pending 等待/超时/disposed）、`tests/runs.test.ts`（stop 补 mission 终结、无 missionId 不动 mission）、`tests/management.test.ts`（setAgentDisabled enable 清空条目）。

注意：插件实例在会话启动时加载，上述修复对**当前会话**的已加载实例不生效；`pnpm build` 产物已更新（lib/runs/spawn.js、lib/runs/execution.js 等），重启 dsh 会话后生效。重启后的验证建议：
- #N1：后台 workflow 一个 lane 用不存在 agent → run 应直接 `failed`（不再悬挂），mission 应自动终结；对悬挂 run `stop` → mission 不再残留 active
- #N2：worker `contact_supervisor` 后结束回合 → run 保持 `running · awaiting supervisor reply`；父 `reply` 后 worker 自动恢复落盘，run 最终 `completed`（无需 resume）
- #N3：`resume` 后 `status` 只有 1 条 run 记录（不再有成对的 running 幽灵）
- #N4：project 作用域 agent `disable` → 标记写入 project overrides（`<root>/.dsh/subagents/overrides.json`），`enable` 后无空条目残留

---

## 八、第二轮修正 + 最终真实回归（2026-08-15，重启后）

第一轮真实回归暴露两处问题，同轮修正（`pnpm build` + `pnpm test` 110 用例全绿，新增 2 个）：

### 修正 A（#N2 首次修复的 bug：pending 查错 key + 前台等待会死锁）

- `supervisor.pending()` 的索引是 **parentSessionId**，首次修复误传 `childSessionId` → 永远查不到 → 等待不触发。改为 `pending(parentSessionId)` + 按 `request.childSessionId` 过滤（`runs/spawn.ts`，`waitForSupervisorResolution` 同步加 `parentSessionId` 参数）。
- **前台 run 的 supervisor 等待会死锁**：工具调用阻塞父回合，父无法回复。新增 `SpawnOptions.supervisorWait`，仅后台 run 启用（`launchSingle` / `launchWorkflow` 的 async 分支传 true；workflow 默认后台仍走等待）。
- 新增测试：`spawn.test.ts` "ignores requests from other children"。

### 修正 B（#N4 引入的回归：disable 后 enable 报 unknown agent）

- `AgentRegistry.resolve` 默认过滤 disabled agent，enable 无法定位。`list`/`resolve` 增加 `includeDisabled` 参数（`agents/registry.ts`），disable/enable 分支传 true（`runs/management-actions.ts`）。
- 新增测试：`registry.test.ts` "resolve includeDisabled"。

### 最终真实回归（重启后，当前会话加载第二次修正版）

| # | 结果 | 证据 |
| --- | --- | --- |
| #N1 | ✅ | lane 异常 workflow `0355d075-ed3` 直接 `failed · 0s`，mission `ba6b7d3e-264` 自动 `failed` |
| #N2 | ✅ 全闭环 | 后台 worker `95a78456-b50` 投递决策 `81e61837` 后：run 保持 `running · awaiting supervisor reply`、mission 保持 `running`；父 `reply` 后 worker **自动恢复**落盘 `gamma`（commandsRun exitCode 0 验证），run `completed · 36s`、mission 自动 `completed`——单 run 内完成等待-唤醒-恢复，无需 resume |
| #N3 | ✅ | resume 后仅 1 条 run 记录 `c2445b4a-ae7 · completed`，无幽灵 |
| #N4 | ✅ | project agent `matrix-n4-final`：disable → `disabled:true` 写入 project overrides；enable 恢复正常（`in project scope`，不再 unknown agent）；enable 后 overrides 恢复 `{"agents":{}}` 无残留；user overrides 全程无污染 |

清理：`tests/.matrix-tmp/` 已删；`matrix-n4-final` 已 delete；仓库 `.dsh` 目录已清理；doctor 复查：0 active runs、0 pending supervisor、schedules 0、watchdog disabled。
