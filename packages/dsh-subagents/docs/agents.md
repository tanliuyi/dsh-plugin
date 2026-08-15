# Agents

An agent is a markdown file: YAML frontmatter on top, a system prompt below.

```yaml
---
name: scout
description: Fast codebase recon
tools: read, grep, glob, bash, write
---
Your system prompt goes here.
```

## Where agents live

Lowest to highest priority:

| Scope | Path |
| --- | --- |
| Builtin | `<package>/agents/` |
| User | `~/.dsh/subagents/agents/**/*.md` |
| Project | `<root>/.dsh/subagents/agents/**/*.md` (root = nearest dir with `.dsh` or `.git`) |

Project definitions win name collisions. `.chain.md` files are ignored. Use `agentScope: "user" | "project" | "both"` to control discovery (default `both`).

## Builtin agents

`scout` (recon), `researcher` (web research), `worker` (implementation), `reviewer` (code review), `oracle` (second opinion, no edits, alias `advisor`), `delegate` (lightweight general). Builtins do not pin a model; they inherit the parent session model unless `defaultModel` or an override sets one.

`oracle` is advisory; `worker` implements approved handoffs and escalates unapproved decisions through `contact_supervisor`.

## Frontmatter reference

Supported fields: `name`, `package`, `aliases`, `description`, `tools` (strict allowlist; names must exist in the dsh tool registry — e.g. `read`, `grep`, `glob`, `bash`, `edit`, `write`, `web_search`, `web_fetch`, `contact_supervisor`, `subagents`), `extensions` (accepted, not enforced), `model`, `fallbackModels`, `thinking`, `systemPromptMode` (`replace` | `append`), `inheritProjectContext`, `inheritSkills`, `skills`, `skillPath`, `output`, `defaultReads`, `defaultProgress`, `defaultContext` (`fresh` | `fork`), `async`, `timeoutMs`, `toolTimeoutMs`, `turnBudget`, `acceptance`, `acceptanceRole` (`read-only` | `writer`), `completionGuard`, `maxSubagentDepth`, `disabled`, `memory` (`{ scope: project|user, path }`).

Simple-scalar list fields accept comma-separated or block-list form.

- `tools` omitted → the child inherits the parent's full tool set; `tools` present → an explicit allowlist; `tools:` empty → no tools.
- `systemPromptMode: append` keeps the harness base prompt; `replace` (default) uses only the agent prompt. Builtins use `replace` with `inheritProjectContext: true`.
- `defaultContext: fork` seeds children with the parent conversation (worker/oracle use it).
- `memory` injects up to 200 lines of `MEMORY.md` from `<scope>/.dsh/subagents/agent-memory/<path>/`; write-capable agents may append dated notes.

## Overrides

`agentOverrides` in plugin config or `<scope>/.dsh/subagents/overrides.json` apply per-agent fields (`description`, `model`, `thinking`, `tools`, `systemPrompt`, `disabled`, `defaultContext`, ...) without editing the agent file. Management actions `disable`, `enable`, `reset` write these files; `eject` copies a builtin into the chosen scope; `delete` removes a custom agent file; `update` on a builtin writes scope overrides.

## Refinement overlays

`/subagents-refine <agent>` (or `subagents({ action: "refine" | "refine.show" | "refine.rollback", agent })`) manages a project-local overlay at `<root>/.dsh/subagents/refinements/<agent>.md`. `refine` collects evidence from recent runs and has the LLM draft small guidance; proposals touching safety, policy, tools, output, acceptance, or system instructions are rejected. The overlay is injected into the child prompt as a `<dsh-subagents-refinement>` block.

## Agent management actions

`subagents({ action: "list" | "get" | "create" | "update" | "delete" | "eject" | "disable" | "enable" | "reset" | "models", ... })` — see `guide` topic `tool-reference`.
