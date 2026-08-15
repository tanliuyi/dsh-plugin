/**
 * Intercom bridge：注入子代理提示词的运行时协调指令（对应 pi-subagents 的
 * intercom-bridge）。指示子代理在阻塞/需要决策时通过 contact_supervisor 联系
 * 父会话，并在结束后正常返回。
 */

import type { SubagentsConfig } from '../types.ts'

export interface BridgeContext {
  parentSessionId: string
  childAgent: string
  forkContext: boolean
  config: SubagentsConfig
}

const DEFAULT_INSTRUCTIONS = `## Runtime coordination (supervisor bridge)

You are a child subagent of session {{orchestratorTarget}}.

- If you are blocked or need a decision that the parent must make, use the
  \`contact_supervisor\` tool with \`reason: "need_decision"\` and include a
  concise message. Wait for the reply in your next turn if the tool returns a
  request id; otherwise return normally and name the decision in your final
  response.
- Use \`reason: "progress_update"\` only for meaningful blocked/progress
  updates or unexpected discoveries that change the plan.
- Do not send routine completion handoffs; return the completed task normally
  when no coordination is needed.
- You are NOT the parent orchestrator: do not propose or launch your own
  subagents unless the agent definition explicitly allows it.`

/** 渲染 bridge 指令块（追加到任务提示之后）。 */
export function renderBridgeInstructions(context: BridgeContext): string {
  const config = context.config.intercomBridge
  if (config.mode === 'off') return ''
  if (config.mode === 'fork-only' && !context.forkContext) return ''
  const template = DEFAULT_INSTRUCTIONS
  const rendered = template.replaceAll('{{orchestratorTarget}}', context.parentSessionId)
  return `\n\n${rendered}`
}

/** doctor 用：检查 bridge 是否激活。 */
export function bridgeActive(config: SubagentsConfig, forkContext: boolean): boolean {
  const mode = config.intercomBridge.mode
  if (mode === 'off') return false
  if (mode === 'fork-only') return forkContext
  return true
}
