# Workflows

The recommended implementation loop is `clarify → scout → worker → fresh reviewers → worker`.

## Scripted workflows (workflowScript)

All model-facing execution is expressed through the `subagents` tool. Use stable keys and ordinary JavaScript:

```js
subagents({ workflowScript: `
  const scan = await runs.run("scan", { agent: "scout", task: "Scan the codebase" });
  const reviews = await runs.all([
    { key: "correctness", agent: "reviewer", task: "Review correctness: " + scan.output },
    { key: "tests", agent: "reviewer", task: "Review tests: " + scan.output }
  ]);
  return reviews.map(result => result.output);
` });
```

- `runs.run(key, { agent, task, context?, gate?, acceptance? })` — one child; `runs.all([...])` runs a wave in parallel. Keys are validated (1–128 chars, `[A-Za-z0-9._-]`); the same key may not be launched twice with incompatible params (fingerprint check, like upstream).
- `runs.status(keyOrRunId)` — the result of an already launched run (by key or run id), or `undefined`.
- `runs.ref(result)` / `runs.refs(results)` — compact run references (`[run <key>; id=<runId8>]`), usable in status queries and logs.
- `await state.get(key)` / `state.set(key, value)` — durable JSON state through the enclosing mission (256 KiB cap).
- `await prompts.render("package:<name>" | "user:<name>" | "project:<name>", vars?)` — renders a prompt template with `{{var}}` placeholders.
- Workflows run in the background by default (`async: true`); pass `async: false` for a foreground run.
- A plain workflow creates one enclosing mission; `mission: false` makes it ephemeral. The result ends with `Mission: <id> (<status>)`.

The sandbox has no filesystem or network access: only `runs`, `state`, `prompts`, and JS builtins.

## Prompt shortcuts

The package ships prompt templates for common workflows, registered as slash commands and available to the model:

| Command | Use it for |
| --- | --- |
| `/parallel-review` | Fresh-context reviewers with distinct angles, then synthesize fixes |
| `/review-loop` | Parent-controlled worker/reviewer/fix cycles until clean or capped (default 3 rounds) |
| `/parallel-research` | `researcher` + `scout` for external evidence and local context |
| `/gather-context-and-clarify` | Scout/research first, then ask the user the questions that matter |
| `/parallel-cleanup` | Review-only cleanup passes after implementation |

Add `autofix` to `/parallel-review` or `/parallel-cleanup` to apply only the synthesized fixes worth doing now.

## Direct command

`/run <agent> [task] [--bg] [--fork]` launches one child directly.

## Supervisor coordination (child asks parent)

A child that is blocked or needs a decision calls `contact_supervisor` with a `reason`:
- `need_decision` — blocking decisions or clarification
- `interview_request` — structured input
- `progress_update` — short non-blocking updates

The parent replies with `subagents_supervisor({ action: "reply", replyTo, message })` or checks pending requests with `subagents_supervisor({ action: "pending" })`. Requests are scoped to the exact parent session.

## Recursion guard

Nested delegation is bounded: main session → subagent → sub-subagent by default (`maxSubagentDepth` config, default 2). A child can call `subagents` only when its agent definition lists `subagents` in `tools`.

## Not ported from pi-subagents

Managed git worktrees (`worktree: true`), durable legacy chains (`.chain.md`, `append-step`), Herdr panes, Orca progress tabs, and external CLI agent profiles are not supported by the dsh port; the corresponding parameters are accepted for compatibility or rejected with a clear message.
