# Models

Builtin agents inherit the parent session model. Layer defaults and overrides:

- `subagents.defaultModel` — default for agents without their own `model`.
- `subagents.agentOverrides.<name>.model` — pin one role (also `thinking`, `fallbackModels`).
- Per-run `model` via... the `subagents` tool accepts model overrides through agent config only; use `/subagents-models [agent]` to inspect the live mapping.

Precedence, strongest first: per-run override → agent frontmatter `model` → `agentOverrides.<name>.model` → `subagents.defaultModel` → the parent session model.

Model ids are pi-style (`provider/model`, optional `:thinking` suffix such as `:high`). Resolution is fuzzy: separator variations (`anthropic/claude-sonnet-4`, `anthropic:claude-sonnet-4`), case differences, and `-`/`.` variations all match the registered adapter catalog. An unresolved model id falls back to inheritance instead of failing the launch.

Thinking levels (`thinking` frontmatter or overrides) map to the harness reasoning-effort vocabulary when the adapter supports it; `false`/`off` disables it.

Fallback models (`fallbackModels`) are recorded for compatibility; the dsh harness owns provider-level retry/fallback policy.
