# Watchdog and child permissions

The watchdog is an opt-in adversarial reviewer for repo edits. It is not the `reviewer` subagent; `defaultModel` and `agentOverrides.reviewer` do not configure it.

## What it reviews

- Runs at the safe turn boundary (`turn/end`), only when the agent or child writer changed the repo state since the start of that turn.
- Multiple edits in one turn are coalesced into one review of the final changed state; unchanged diffs are skipped.
- Generated `.dsh/subagents/` artifacts do not trigger review.

## Configuration

```json
{ "watchdog": { "enabled": true, "main": { "model": "anthropic/claude-opus-4-8", "thinking": "high" } } }
```

`subagents({ action: "watchdog.configure", model: "recommended" | "inherit" | "<model>", thinking, scope: "session" | "user" | "project" })` writes session/user/project configuration; `/subagents-watchdog on|off|model <id>|recommend-model|status|check` is the slash equivalent.

The current recommendation is a strong complementary model (Opus-class with high thinking, or a top GPT when the main session uses Anthropic).

## Scope monitoring

`watchdog.scope.enabled` keeps a bounded in-memory summary of recent user prompts and prepends it to review input, so the reviewer can flag `scope-drift` — work that no longer serves the current scope.

## Cadence

`watchdog.cadence.everyNTools` runs additional non-blocking reviews every N tool results (Scopey-style monitoring; use a cheap model).

## Auto-follow

`watchdog.autoFollow` (`blockers`, `maxAttempts`, `stalemateRepeats`) queues a visible follow-up user message asking the agent to address a blocker; repeated identical blockers stop after `stalemateRepeats`.

## Child watchdogs

`watchdog.children.model` / `watchdog.children.overrides.<agent>.model` review writer children at their own turn boundary.

## LSP diagnostics

Not ported: the pi-subagents LSP pre-review is skipped by the dsh port.

## Child tool permissions

`permissions.rules` maps tool names to `allow` | `ask` | `deny` for child tool calls. The dsh port has no interactive arbiter UI, so `ask` degrades to a deterministic `deny` with a clear error; `bash` is never gated. Agent frontmatter `permission` blocks are accepted and merged over global rules.
