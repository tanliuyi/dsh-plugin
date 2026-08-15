# Configuration

All keys live in the plugin's cordis config (profile `cordis.patch.yml` / `config` block). Environment overrides: `PI_SUBAGENT_MAX_SPAWNS_PER_SESSION`, `PI_SUBAGENT_MAX_SPAWNS_PER_RUN` are not read by the dsh port (use config).

| Key | Default | Meaning |
| --- | --- | --- |
| `toolDescriptionMode` | `compact` | `full` \| `compact` \| `custom` (custom reads `<project>/.dsh/subagents/subagent-tool-description.md` or `~/.dsh/subagents/subagent-tool-description.md`; `{{fullDescription}}`/`{{compactDescription}}` placeholders). |
| `asyncByDefault` | `true` | Workflows default to background when the call omits `async`. |
| `timeoutMs` | 30 min | Global default run deadline (foreground and plain single-agent async). |
| `toolTimeoutMs` | — | Accepted for compatibility; not enforced inside dsh children. |
| `gateTimeoutMs` | `120000` | Execution timeout for `gate` verification commands. |
| `maxSubagentSpawnsPerSession` | unlimited | Session-wide cumulative launch cap; `0` disables a configured cap. |
| `maxSubagentSpawnsPerRun` | `64` | Cumulative logical children in one run tree. |
| `maxActiveAsyncRunsPerSession` | unlimited | Concurrent top-level background run cap. |
| `maxSubagentDepth` | `2` | Nested delegation depth cap (main → child → sub-child). |
| `defaultModel` | — | Default subagent model (below overrides win). |
| `defaultThinking` | — | Default thinking level for agents without one. |
| `agentOverrides` | `{}` | Per-agent overrides (description/model/thinking/tools/systemPrompt/disabled/...). |
| `disableBuiltins` | `false` | Hide all builtin agents. |
| `parallel.maxTasks` / `concurrency` | `8` / `4` | Parallel wave bounds. |
| `missions.enabled` | `true` | Automatic mission creation. |
| `missions.directory` | `~/.dsh/subagents/missions/projects` | Mission record root (absolute, `~/`, or project-relative). |
| `missions.retainTerminal` | `200` | Prune keeps only this many terminal records. |
| `missions.globalIndex` | `true` | Write the user-local pointer index. |
| `scheduledRuns.enabled` | `true` | Durable schedules. |
| `scheduledRuns.storeRoot` | `<root>/.dsh/subagents/schedules` | Schedule store root. |
| `scheduledRuns.maxPending` | `20` | Pending schedule cap. |
| `intercomBridge.mode` | `always` | `always` \| `fork-only` \| `off` — child coordination instructions. |
| `intercomBridge.resultDelivery` | `false` | Accepted for compatibility (no external result intercom in the dsh port). |
| `watchdog.enabled` | `false` | Opt-in adversarial change reviewer. |
| `watchdog.main.model` / `thinking` | inherit | Main watchdog model. |
| `watchdog.children.model` / `overrides` | inherit | Child watchdog model / per-role overrides. |
| `watchdog.scope.enabled` | `false` | Bounded current-scope monitoring (drift detection). |
| `watchdog.cadence.everyNTools` | — | Extra non-blocking review every N tool results. |
| `watchdog.autoFollow` | `{ blockers: false, maxAttempts: 3, stalemateRepeats: 3 }` | Queue follow-up instructions for blockers. |
| `permissions.rules` | `{}` | Per-tool `allow`/`ask`/`deny` rules for child tool calls. `ask` degrades to `deny` in the dsh port (no interactive arbiter UI); `bash` is never gated. |
| `artifactDir` | `temp` | `project` \| `session` \| `temp` artifact preference. |
| `forceTopLevelAsync` | `false` | Force depth-0 runs into background. |
| `waitTool.enabled` | `true` | `subagents_wait` tool visibility. |

Model precedence for children: per-run override → agent frontmatter `model` → `agentOverrides.<name>.model` → `defaultModel` → parent session model. Model ids accept pi-style `provider/model[:thinking]` strings and are resolved against the registered dsh adapters (fuzzy match on separators/case); unresolved models fall back to inheritance.
