# Missions and schedules

Missions are durable wrappers around runs so you can recover delegated work later.

## Missions

Ordinary launches and workflows create one enclosing mission by default, with records under `~/.dsh/subagents/missions/projects/<project-hash>/<id>/` (or `missions.directory` config). Children do not create separate missions. `mission: false` makes a run ephemeral. `missions.enabled: false` disables automatic creation (explicit `missionId`/`mission` still work).

- `subagents({ action: "mission.create", mission: { title | summary, objective?, goal?, budget?, labels? } })` — exactly one non-empty `title` or `summary`.
- `mission.list` / `mission.show` / `mission.update` (records decisions, receipts, artifacts, labels, `nextReadyAction`) / `mission.resolve-decision` / `mission.attach-run` / `mission.close`.
- Adding a decision gates an active mission as `needs_decision`; resolving the last open decision returns it to `active`.
- Receipts record delivery state only (`kind`, `status`, `title`, `url`) — the plugin never merges, polls CI, or deploys.
- `mission.list` with `missionScope: "global"` reads the user-local pointer index; missing records are reported as stale.

### Goal missions

`goal: true` with `budget: { tokens }` makes a mission an active continuation driver: after each parent turn, one needs-attention notice is delivered with the mission title, remaining token budget, and next ready action (`state.nextReadyAction` or an open decision). Reaching the budget sets `budget-exhausted` and stops notices. Pause with `mission.update` `{ goal: { paused: true } }`.

### Durable workflow state

A mission-backed workflow gets `await state.get(key)` / `state.set(key, value)` backed by `<mission-dir>/state.json` (strict 256 KiB cap). `mission: false` workflows have no `state`.

## Schedules

Durable schedules live under `<root>/.dsh/subagents/schedules/<project-hash>/<id>/` (or `scheduledRuns.storeRoot`).

```js
subagents({ action: "schedule.create", id: "evening-review", name: "Evening review", at: "+30m", workflowScript: `return runs.run("main", { agent: "reviewer", task: "Review the current diff." })` })
subagents({ action: "schedule.create", id: "backlog", every: "6h", catchUp: "latest", workflowScript: "..." })
```

- `at` accepts relative delays (`+10m`, `+6h`, `+2d`, `+1w`) and ISO timestamps; `every` accepts `m`/`h`/`d`/`w` units and advances from the planned time.
- Actions: `schedule.list`, `schedule.show`, `schedule.history`, `schedule.pause`, `schedule.resume`, `schedule.run`, `schedule.run-due`, `schedule.delete`.
- Runs always launch async with fresh context and no automatic mission. Overlap is fixed to `skip`; `catchUp` supports `latest` (default) and `none`.
- `schedule.run-due` lets an external launcher start due work without a daemon.
