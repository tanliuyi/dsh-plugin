# Extension API (dsh port)

pi-subagents exposes several extension seams; the dsh port maps them onto dsh's native plugin surface.

## Cordis events

- `subagent/start` / `subagent/end` (from `@deepseek-ai/dsh-subagent`) — child lifecycle, scoped to the delegating parent.
- `session/event` — durable session events (`turn/end`, `tool/result`) for observers such as the goal driver and watchdog.
- `tools/result` — tool pipeline observation.

Plugins compose with the port through `ctx.subagents` (the native seam) directly; there is no pi-style in-process RPC bus. The `subagents` tool's behavior — agent discovery, budgets, child-safety depth, artifacts, async status — is the same executor exposed to the model, so a plugin that needs launch behavior should call `ctx.subagents.start()` itself (native) or reuse this package's executor via `src/runs/execution.ts` (`executeSubagents`), which is exported for programmatic use.

## Preflight

`@dsh-plugins/dsh-subagents/preflight` exports `resolveSubagentLaunchContract({ agent, task, context, cwd, sessionRoot, availableModels })` — a side-effect-free resolution of the child launch contract (agent identity, effective tools allowlist, provider/model route, fork/fresh context, digests) with `ok: false` + `message` for `missing_agent`, `ambiguous_agent`, `denied_required_tool`, `invalid_cwd`, and `unsupported_mode`.

## Background-work providers / external runs

Not ported (dsh has the native `ctx.jobs` registry; `dsh-tool-jobs` renders background work).

## Capability ceilings

Not ported as a separate API; the dsh port enforces its own budgets (`maxSubagentSpawnsPerRun`, `maxActiveAsyncRunsPerSession`, `maxSubagentDepth`) and tool allowlists per agent. Host-level restrictions belong to dsh's native tools registry (`ctx.tools.restrict`).
