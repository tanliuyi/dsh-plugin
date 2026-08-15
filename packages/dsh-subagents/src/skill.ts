/**
 * 注册内置 pi-subagents 技能（ctx.skills，可选服务）。内容为上游 SKILL 的
 * dsh 移植：面向 parent orchestrator，工具名为 `subagents`。
 */

import type { Context } from '@deepseek-ai/cordis'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

function skillDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'pi-subagents')
}

const SKILL_BODY = `# Subagents (dsh port of the pi-subagents skill)

This skill is for the main parent orchestrator only. Do not inject or follow it
inside spawned child subagents. The parent session owns delegation, orchestration,
review fanout, and final fix-worker launches. Ordinary children should not run
their own subagent workflows; the explicit exception is a delegated fanout child
whose agent definition lists \`subagents\` in its \`tools\` allowlist.

Use this skill when the parent orchestrator needs one specialized child or composed
orchestration. Use the \`subagents\` tool:

- One child: \`subagents({ agent, task })\` — \`agent\` is optional; the router picks
  a builtin agent from the task. \`context: "fork"\` seeds the child with this
  conversation; "fresh" (default for most agents) is standalone.
- Scripted workflows: \`subagents({ workflowScript })\` with \`runs.run(key, { agent,
  task })\` for one child and \`runs.all([...])\` for coordinated waves. Workflows
  start in the background by default; pass \`async: false\` only for a small
  foreground run.
- Management/control: \`subagents({ action })\` — status, interrupt, stop, steer,
  resume, list/get/create/update/delete/eject/disable/enable/reset agents,
  mission.*, schedule.*, watchdog.*, guide, doctor, children.list,
  grant-spawn-budget, models, refine.

Builtin roles: scout (recon before you understand the code), researcher (external
facts), worker (implementation), reviewer (check), oracle (risky decisions,
challenges assumptions without editing), delegate (lightweight general).

Always-on constraints:

- Keep the parent as orchestrator and final decision-maker.
- Use one writer per working directory unless isolated work is intentional.
- For parallel fanout, compare child prompts before launch; each child needs a
  lane-specific task, source seam, prior evidence, and decision. Prefer
  fresh-context review/validation fanout, then synthesize and apply fixes in the
  parent.
- Use background/async by default when work can proceed independently; do not poll
  just to wait.
- Preserve capability ceilings: children only get tools listed in their agent
  allowlist, and nested delegation is bounded by maxSubagentDepth.
- Escalate unresolved product, architecture, authority, release, merge, or safety
  decisions upward instead of letting a child decide silently.
- Treat receipts, CI, review bots, and external-run records as evidence, not
  authority to merge, close, comment, publish, or release.
- Do not set hard turn/tool budgets on mutation-capable workers; bound writer work
  with a narrow task and an outer timeoutMs that leaves margin.
- A child that is blocked or needs a decision calls \`contact_supervisor\`; reply
  with \`subagents_supervisor\` ({ action: "reply", replyTo, message }) or check
  pending requests with ({ action: "pending" }).`

/** 注册技能（幂等：同名重复注册仅警告）。 */
export function registerSubagentsSkill(ctx: Context): () => void {
  const skills = ctx.get('skills')
  if (!skills) return () => {}
  try {
    return skills.register({
      name: 'subagents',
      description: 'Delegate work to builtin or custom subagents with single-agent, scripted, parallel, async, forked-context, and coordinated workflows; manage agents, missions, schedules, and the watchdog.',
      whenToUse: 'The parent orchestrator needs one specialized child (scout/researcher/worker/reviewer/oracle/delegate) or composed multi-agent orchestration.',
      // dsh-skill 的 register 契约：`source` 与 `content` 都必须是字符串
      // （validateDefinition 对两者逐一校验；缺任一即加载失败）。
      source: SKILL_BODY,
      content: SKILL_BODY,
      resourceBase: { kind: 'directory', path: skillDir() },
    })
  } catch (error) {
    // 注册失败（如名称冲突）记录诊断而不是静默
    ctx.logger.warn(`[dsh-subagents] skill registration failed: ${String(error)}`)
    return () => {}
  }
}
