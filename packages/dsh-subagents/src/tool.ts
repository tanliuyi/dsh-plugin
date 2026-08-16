/**
 * `subagents` 工具定义：pi-subagents 移植的面向前台工具。
 * 名字用复数避免与 dsh 原生的 `subagent` / `subagent_fork` 冲突。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SubagentsParams } from './types.ts'
import type { SubagentsDeps } from './runs/execution.ts'
import { executeSubagents, type SessionState } from './runs/execution.ts'
import { guideTopics } from './guide.ts'

const DESCRIPTION = `Delegate work to focused child agents (pi-subagents style orchestration for dsh).

Execution modes (choose exactly one):
- \`{ agent, task }\` — one child with a builtin or custom agent. Omit \`agent\` to have the router pick one.
- \`{ workflowScript }\` — a scripted workflow run in a sandbox with \`runs.run(key, { agent, task })\`, \`runs.all([...])\`, \`await state.get/set(key)\` and \`await prompts.render("package:<name>", vars)\`. Workflows run in the background by default (pass \`async: false\` to wait in the foreground).
- \`{ action }\` — management/control: status, interrupt, stop, steer, resume, list/get/create/update/delete/eject/disable/enable/reset agents, mission.*, schedule.*, watchdog.*, guide, doctor, children.list, grant-spawn-budget, models, refine.

Builtin agents: scout (codebase recon), researcher (web research), worker (implementation), reviewer (code review), oracle (second opinion, no edits), delegate (lightweight general). Rules of thumb: scout before you understand the code, researcher before you trust external facts, worker to implement, reviewer to check, oracle when the decision feels risky.

Context: \`context: "fresh"\` starts a standalone child; \`context: "fork"\` seeds the child with this conversation's completed turns (worker/oracle default to fork).

Background: pass \`async: true\` to run a single child in the background; check it with \`{ action: "status" }\` and stop with \`{ action: "stop", id }\`.

Safety: children never inherit ambient extension tools unless listed in their agent \`tools\` allowlist; nested delegation is bounded by maxSubagentDepth. A child calls \`contact_supervisor\` to ask you for a decision; reply with \`subagents_supervisor\` ({ action: "reply", replyTo, message }).`

/** 注册 `subagents` 工具。 */
export function registerSubagentsTool(ctx: Context, deps: SubagentsDeps, sessionState: SessionState): () => void {
  return ctx.tools.register(defineTool({
    name: 'subagents',
    description: DESCRIPTION,
    parameters: {
      agent: { type: 'string', description: 'Agent for one-child execution, or target for agent management actions.' },
      task: { type: 'string', description: 'One-child task. Requires agent; cannot combine with action or workflowScript.' },
      action: {
        type: 'string',
        description: 'Management/control action: status, list, get, create, update, delete, eject, disable, enable, reset, refine, refine.show, refine.rollback, models, guide, doctor, interrupt, stop, steer, resume, children.list, grant-spawn-budget, debug.run, mission.create/list/show/update/resolve-decision/attach-run/close, schedule.create/list/show/history/pause/resume/run/run-due/delete, watchdog.configure/recommend-model/status/check.',
      },
      topic: { type: 'string', enum: guideTopics(), description: 'Packaged guide topic for action: "guide".' },
      config: { type: 'json', description: 'Agent config for create/update management actions.' },
      agentScope: { type: 'string', enum: ['user', 'project', 'both'], description: 'Agent discovery scope; project wins on collisions.' },
      context: { type: 'string', enum: ['fresh', 'fork'], description: 'fresh = standalone child; fork = child seeded with this conversation.' },
      async: { type: 'boolean', description: 'Run in the background (single children default to foreground; workflows default to background).' },
      workflowScript: { type: 'string', description: 'Sandboxed JavaScript workflow body using runs.run / runs.all / state / prompts.render.' },
      missionId: { type: 'string', description: 'Attach to an existing mission.' },
      mission: { type: 'json', description: 'Override the enclosing mission: { title | summary, objective?, goal?, budget?, labels? }. false = ephemeral.' },
      missionUpdate: { type: 'json', description: 'Mission update object for action="mission.update" (objective, goal false or { paused }, budget, summary, labels, decisions, artifacts, receipts).' },
      missionStatus: { type: 'string', description: 'Target status for mission.create/close.' },
      runMode: { type: 'string', description: 'Attached run mode for mission.attach-run.' },
      runStatus: { type: 'string', description: 'Attached run status for mission.attach-run (default "running").' },
      timeoutMs: { type: 'integer', description: 'Run-level max runtime in milliseconds (default 30 minutes).' },
      maxRuntimeMs: { type: 'integer', description: 'Alias of timeoutMs.' },
      toolTimeoutMs: { type: 'integer', description: 'Per-tool timeout in ms: a tool call still running past the limit aborts the child (wait-type tools exempt; explicit config only — no default fast-tool timeout).' },
      turnBudget: { type: 'json', description: 'Soft turn budget { maxTurns, graceTurns? }: steer wrap-up at maxTurns, abort past maxTurns + graceTurns (grace 1 by default).' },
      toolBudget: { type: 'json', description: 'Tool-call budget { soft?, hard, block? }: steer nudge at soft; past hard, blocked tools (default read/grep/find/ls) are announced as forbidden via steer. dsh cannot hard-block a tool call.' },
      usageBudget: { type: 'json', description: 'Chain-level usage gate for workflows: { tokens: { soft?, hard } } — accumulated token estimate per workflow, hard limit rejects further children. costUsd is recorded but not enforced.' },
      acceptance: { type: 'json', description: 'Evidence gate: "auto"|"none"|"attested"|"checked"|"verified", or { level, reason?, criteria?, evidence?, verify?, review? }. none requires a reason. false disables.' },
      gate: { type: 'string', description: 'One host-run verification command; shorthand for acceptance: { level: "verified", verify: [{ id: "gate", command }] }. Cannot combine with acceptance.' },
      cwd: { type: 'string', description: 'Accepted for compatibility; dsh children inherit the parent session working directory.' },
      maxOutput: { type: 'json', description: 'Output truncation limits { maxChars?, maxLines? }.' },
      includeProgress: { type: 'boolean' },
      share: { type: 'boolean', description: 'Not supported by the dsh port (no Gist upload).' },
      sessionDir: { type: 'string', description: 'Accepted for compatibility; artifacts live under the dsh tmp run directory.' },
      structuredOutputSchema: { type: 'json', description: 'JSON Schema for structured output: the child must finish with a schema-valid structured result (returned in the result row as structuredOutput).' },
      index: { type: 'integer', description: 'Zero-based child index for status/steer/resume targeting.' },
      lines: { type: 'integer', description: 'Maximum transcript lines for status view="transcript" (default 80, cap 500).' },
      mode: { type: 'string', enum: ['steer', 'follow_up', 'auto'], description: 'Delivery mode for steer.' },
      view: { type: 'string', enum: ['fleet', 'transcript'], description: 'status view.' },
      resume: { type: 'string', description: 'Deprecated alias of id for action: "resume" (retained child id from children.list).' },
      id: { type: 'string', description: 'Run id for status/interrupt/stop/steer/resume or schedule id.' },
      runId: { type: 'string', description: 'Run id alias for mission.attach-run.' },
      name: { type: 'string', description: 'Schedule name for schedule.create.' },
      message: { type: 'string', description: 'Message for steer/resume, or mission summary for mission.close.' },
      at: { type: 'string', description: 'One-shot trigger for schedule.create: "+10m" or ISO timestamp.' },
      every: { type: 'string', description: 'Fixed recurring interval for schedule.create: "30m", "6h", "2d", "1w".' },
      additional: { type: 'integer', description: 'Positive launches to add with action: "grant-spawn-budget".' },
      scope: { type: 'string', enum: ['session', 'user', 'project'], description: 'Scope for watchdog.configure.' },
      thinking: { type: 'json', description: 'Thinking level for watchdog.configure.' },
      model: { type: 'string', description: 'Default child model override (e.g. "anthropic/claude-sonnet-4"); overrides agent frontmatter and config.defaultModel for this launch.' },
      target: { type: 'string', enum: ['main', 'children', 'child'], description: 'Watchdog action target.' },
      decisionId: { type: 'string', description: 'Decision id for mission.resolve-decision.' },
      missionScope: { type: 'string', enum: ['project', 'global'], description: 'mission.list scope.' },
      replyTo: { type: 'string', description: 'Request id for subagents_supervisor reply (unused here; see subagents_supervisor tool).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (!parent) throw new Error('subagents tool requires a calling agent')
      const params: SubagentsParams = { ...args } as SubagentsParams
      const result = await executeSubagents(deps, sessionState, {
        parent,
        signal: exec.signal,
        cwd: parent.session.header.cwd ?? process.cwd(),
      }, params)
      const missionLine = result.details.missionId && !result.text.includes(`Mission: ${result.details.missionId}`)
        ? `\nMission: ${result.details.missionId} (${result.details.state ?? 'active'})`
        : ''
      return `${result.text}${missionLine}`.trim()
    },
  }))
}
