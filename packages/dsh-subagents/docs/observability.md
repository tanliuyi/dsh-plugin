# Observability

## Status

`subagents({ action: "status" })` shows active and recent runs of the current session:

```text
1 active run(s), 3 total
● abc123def · worker · running · 1m 12s
    worker · running · 1m 12s · ↓ 2.8k tokens
```

- `subagents({ action: "status", view: "fleet" })` — compact fleet view of active children.
- `subagents({ action: "status", id: "<run-id>", view: "transcript", lines: 80 })` — transcript tail (cap 500).
- `subagents({ action: "status", id })` resolves exact ids and prefix matches.
- Run ids are returned by launches; `children.list` shows retained children (last 10) with `resumable` state.

## Run artifacts

Each run writes under `<tmpdir>/dsh-subagents-runs/<session>/<run-id>/`:
- `status.json` — lifecycle projection (mode, state, children, tokens, timing)
- `events.jsonl` — lifecycle events (`subagent.step.started`, `subagent.child.started`, `subagent.steer.delivered`, ...)
- `output-<index>.log` — live human-readable tails

Consumers should read these JSON files instead of scraping text.

## Control

- `interrupt <id>` cancels the current turn but keeps queued inbox work (a pause, not a stop).
- `stop <id>` cancels and terminates a top-level background run (not resumable).
- `steer <id> message` delivers guidance to a running child; `mode: "follow_up"` queues it as the first brief for the next resume of a completed retained child.
- `resume <id> message` starts a fallback challenge child seeded with the previous output (retained children are one-shot sessions; the dsh port revives the work, not the session).

## Completion notifications

Background runs are dsh jobs: collect with `job_output`/`job_kill` semantics via the generic jobs surface, and their terminal state lands in `status`. Goal missions and supervisor requests deliver needs-attention notices as follow-up user messages.
