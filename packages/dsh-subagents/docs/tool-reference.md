# Tool reference

Parameters and actions for the `subagents` tool. Most users ask naturally or use slash commands.

## Execution examples

```js
// One child
{ agent: "scout", task: "Analyze the auth flow" }

// Sequential workflow
{ workflowScript: `
  const scan = await runs.run("scan", { agent: "scout", task: "Analyze auth" });
  return (await runs.run("implement", { agent: "worker", task: "Implement from: " + scan.output })).output;
` }

// Parallel workflow
{ workflowScript: `
  const results = await runs.all([
    { key: "backend", agent: "reviewer", task: "Review backend" },
    { key: "frontend", agent: "reviewer", task: "Review frontend" }
  ]);
  return results.map(result => result.output);
` }
```

## Parameters

| Param | Meaning |
| --- | --- |
| `agent` | Agent for one-child execution or management target. Omit with `task` to let the router pick. |
| `task` | One-child task. |
| `action` | Management/control action (below). |
| `topic` | Guide topic for `action: "guide"`. |
| `config` | Agent config for create/update. |
| `agentScope` | `user` \| `project` \| `both` (default `both`). |
| `context` | `fresh` \| `fork`; per-agent `defaultContext` applies when omitted (worker/oracle default to `fork`). |
| `async` | Background execution (single children default to foreground; workflows default to background). |
| `workflowScript` | Sandboxed workflow body. |
| `missionId` / `mission` | Mission attachment / override (`false` = ephemeral). |
| `timeoutMs` / `maxRuntimeMs` | Run deadline (default 30 minutes). |
| `toolTimeoutMs` | Per-tool timeout in ms: a tool call still running past the limit aborts the child via cancel (wait-type tools exempt; explicit config only — upstream's default fast-tool timeout is not adopted). |
| `toolBudget` | Tool-call counting + steer nudges: soft nudge at `soft`, blocked tools (default `read/grep/find/ls`) announced as forbidden past `hard`; dsh cannot hard-block a tool call. |
| `turnBudget` | Enforced: persona soft-budget injection + global turn counting; steer wrap-up at `maxTurns`, abort past `maxTurns + graceTurns` (grace 1 by default). |
| `usageBudget` | Chain-level `tokens.hard` gate for workflows (tokenMeter heuristic); `costUsd` recorded, not enforced. |
| `completionGuard` | Enforced: implementation tasks that finish without any mutating tool call fail with "Subagent completed without making edits for an implementation task." (tool/call observation substitutes upstream message-flow detection). |
| `structuredOutputSchema` | JSON Schema; child must finish with a schema-valid structured result (dsh native `outputSchema`); result available as `structuredOutput` in the result row. |
| `acceptance` / `gate` | Evidence gates (below). |
| `maxOutput` | `{ maxChars?, maxLines? }` output truncation (default 200 KB). |
| `index` | Child index for status/steer/resume targeting. |
| `lines` | Transcript lines (default 80, cap 500). |
| `view` | `fleet` \| `transcript` for status. |
| `mode` | `steer` \| `follow_up` \| `auto` for steer. |
| `resume` | 已弃用：`id` 的别名（retained child id from `children.list`）。用 `id` 传参。 |
| `at` / `every` | Schedule triggers. |
| `scope` | `session` \| `user` \| `project` for `watchdog.configure`（session = 不落盘会话覆盖；user/project = 写入对应 settings 文件）。 |
| `target` | `main` \| `children` \| `child`（+ `agent`）for `watchdog.configure`。 |

## Actions

### Agent management

`list`, `get`, `create` (config: `name`, `package`, `description`, `aliases`, `tools`, `model`, `fallbackModels`, `thinking`, `systemPrompt`, `systemPromptMode`, `inheritProjectContext`, `inheritSkills`, `defaultContext`, `acceptanceRole`, `output`, `reads`, `progress`, `timeoutMs`, `turnBudget`, `acceptance`, `maxSubagentDepth`, `scope`), `update`, `delete`, `eject`, `disable`, `enable`, `reset`, `refine` / `refine.show` / `refine.rollback`, `models`.

### Status and control

`status`, `interrupt`, `stop`, `steer`, `resume`, `children.list`, `grant-spawn-budget` (root interactive parent only), `doctor`, `guide`.

### Missions and schedules

`mission.create/list/show/update/resolve-decision/attach-run/close`, `schedule.create/list/show/history/pause/resume/run/run-due/delete`.

### Watchdog

`watchdog.configure` (`model`: `recommended` | `inherit` | id, `thinking`, `scope`: `session` | `user` | `project`, `target`: `main` | `children` | `child` + `agent`), `watchdog.recommend-model`, `watchdog.status`, `watchdog.check` — 完整语义见 [watchdog.md](watchdog.md)。

## Acceptance gates

```js
{ agent: "worker", task: "Implement the fix", acceptance: {
  level: "verified",
  criteria: ["Patch the bug without widening scope"],
  evidence: ["changed-files", "tests-added", "commands-run", "residual-risks", "no-staged-files"],
  verify: [{ id: "focused", command: "npm test", timeoutMs: 120000 }]
} }
```

`gate: "npm test"` is shorthand for verified acceptance with that single host-run command. Levels: `auto` (default; writers infer `checked`, risky async writers add required review, read-only tasks attest), `none` (requires `reason`), `attested`, `checked`, `verified`. The bare string `"none"` is rejected; `"reviewed"` is not a policy level. The child prompt asks for a fenced `acceptance-report` JSON block; evidence status (`claimed`/`attested`/`checked`/`verified`/`review-required`/`reviewed`/`rejected`) is recorded per child.

## Not ported

`share` (Gist upload), `worktree`, `chainName`/`append-step`, `handoffPath`, `sessionDir`, `cwd` (children inherit the parent session cwd), `step`, `schedule` (legacy), `chatProgress`, `focus` — accepted for compatibility or rejected with a clear message.
