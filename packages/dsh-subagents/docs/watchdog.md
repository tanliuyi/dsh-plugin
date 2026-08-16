# Watchdog and child permissions

The watchdog is an opt-in adversarial reviewer for repo edits, ported 1:1 from pi-subagents
`src/watchdog/` (HEAD `47552b5`). It is not the `reviewer` subagent; `defaultModel` and
`agentOverrides.reviewer` do not configure it.

## What it reviews

- Reviews at the **run boundary** (`turn/end` ≈ upstream `agent_end`), only when the repo
  change signature differs from the turn-start baseline (`reviewChangesOnly`, like upstream's
  main watchdog).
- The review input is the **turn delta** — a summary of what the agent did in the turn:
  user prompt, assistant text/thinking, tool calls (edit/write payloads redacted), tool
  results (including fs-tool diffs) — plus the scope block, changed repo paths, and LSP
  diagnostics. The reviewer is a **read-only agent** (`read`/`grep`/`glob`) that inspects
  files to verify concerns and returns structured warnings
  (`severity/category/confidence/summary/evidence/recommendedAction`).
- Deltas are deduplicated by change signature (same uncommitted diff is reviewed once) and by
  review-input signature.

## Runtime semantics (aligned with upstream)

- **State machine**: `idle → queued → reviewing → (waiting-at-agent-end) → stale|failed`,
  with epoch invalidation, `agentEndTimeoutMs` (30s) review timeout (timeout → review marked
  `stale`), and `reviewRetryDelayMs`/`maxReviewFailures` failure retries.
- **Boundary delivery (held)**: warnings found at the turn boundary are delivered after the
  run ends — to an idle agent as a follow-up message (upstream transcript display); if a new
  turn already started, the warning is withheld and logged (`lateWarningPolicy:
  show-stale-no-autofollow` — stale warnings never auto-follow).
- **Cadence (`cadence.everyNTools`, ≥5)**: mid-run reviews every N tool results; their
  warnings are **steered into the running agent** (`agent.inject`, upstream `deliverAs:
  "steer"`). A boundary review supersedes any in-flight cadence review.
- **Emission guard**: warnings are filtered by content-free phrase suppression, identity
  dedupe, `severityThreshold`, `maxWarnings` budget, and one-accepted-per-update budget
  (upstream `WatchdogEmissionGuard`).
- **Auto-follow**: blockers additionally queue a real follow-up user message (upstream
  `sendUserMessage`), recognized on the next turn by content match against the pending queue
  plus the dsh plugin message source; `autoFollow.blockers` **default on**, `maxAttempts` 3,
  `stalemateRepeats` 3 (identical blockers stop auto-follow and mark stalemate).
- **Scope monitoring** (`scope.enabled`, **default on**): bounded summary of recent **real
  user prompts** (`user/message` with `source.kind === 'user'`; the watchdog's own
  follow-ups are excluded) prepended to review input with supersede semantics for
  `scope-drift` detection.
- **LSP diagnostics** (`lsp.enabled`, default on): at the boundary, fresh diagnostics for
  changed files are collected (typescript-language-server over JSON-RPC, `timeoutMs` 3s,
  `maxFiles` 20, `maxDiagnostics` 50), can emit a boundary warning, and are included in the
  review input.

## Configuration layers

Precedence (low → high): built-in defaults → plugin config face (`cordis.patch.yml` +
Web settings page overrides) → **user file** (`~/.dsh/subagents/watchdog.json`) → **project
file** (`<root>/.dsh/subagents/watchdog.json`) → **session override** (in-memory, not
persisted). Any source with invalid fields reports an error into `errors`; with any error the
watchdog is disabled until the config is fixed (`configOk`). The user file is the flat
watchdog shape `{ enabled, main: {…}, … }`.

```json
{ "watchdog": { "enabled": true, "main": { "model": "anthropic/claude-opus-4-8", "thinking": "high" } } }
```

Full field surface (all optional in config): `enabled`, `delivery`, `showDuringRun`,
`syncBacklog`, `agentEndTimeoutMs`, `lateWarningPolicy`, `severityThreshold`, `maxWarnings`,
`guidance`, `autoFollow`, `scope`, `cadence`, `main`, `children`, `asyncCompletion`, `lsp`,
`compactAtPercent`, `reviewRetryDelayMs`, `maxReviewFailures`.

The current recommendation is a strong complementary model (Opus-class with high thinking, or
a top GPT when the main session uses Anthropic).

## Commands

`/subagents-watchdog` (full upstream command surface):
`status | on | off | session on | session off | model recommended | model <provider/model[:thinking]> | model inherit | thinking <level> | thinking inherit | session model recommended | recommend-model | check | test concern <text> | test blocker <text>`.

`subagents({ action: "watchdog.configure", model | thinking, scope: "session" | "user" | "project", target: "main" | "children" | "child" (+ agent) })`:
`session` scope applies a non-persisted session override (main target only); `user`/`project`
write the corresponding settings file, including per-agent child overrides.

The Web settings page exposes `watchdogEnabled` / `watchdogMainModel` / `watchdogMainThinking`;
changed values are written to both the page store and the user watchdog file so the two UI
surfaces cannot override each other.

## Child watchdogs

Child (subagent) sessions get their own runtime instance (upstream `register-child`
semantics, in-process): `children.enabled` (default off), `children.model`/`thinking`,
per-agent `children.overrides.<agent>`, `children.autoFollow`, `children.watchdogTailTimeoutMs`
accepted (no process exit in-process). Child warnings deliver into the child session.

## Platform notes (dsh adaptation)

- No transcript-card mechanism: warnings are delivered as messages with the upstream
  `<subagent_watchdog>` XML content.
- The review agent runs as a one-shot read-only subagent with `outputSchema` structured
  output instead of a tool-call emission loop; the emission guard still filters every
  warning.
- `turn/end` dispatch is synchronous, so the review runs concurrently with the next turn
  instead of blocking it; late warnings follow `lateWarningPolicy` (stale, no auto-follow).
- Per-agent thinking is not settable through dsh's `AgentOptions`; reviewer thinking follows
  the deployment default (thinking config is still parsed, validated, and displayed).
- `find`/`ls` do not exist in the dsh tool registry; the reviewer uses `read`/`grep`/`glob`.

## Child tool permissions

`permissions.rules` maps tool names to `allow` | `ask` | `deny` for child tool calls. The dsh port has no interactive arbiter UI, so `ask` degrades to a deterministic `deny` with a clear error; `bash` is never gated. Agent frontmatter `permission` blocks are accepted and merged over global rules.
