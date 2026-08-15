/**
 * 模型映射视图：`subagents({ action: "models" })` 显示每个 agent 的有效模型
 * （frontmatter > agentOverrides > defaultModel > 继承 parent）。
 */

import type { SubagentsDeps, ExecContext } from '../runs/execution.ts'

/** 渲染 agent → 有效模型映射文本（frontmatter > agentOverrides > defaultModel > 继承 parent）。 */
export async function formatModelMapping(deps: SubagentsDeps, exec: ExecContext, projectRoot: string, agentName?: string): Promise<string> {
  const agents = await deps.registry.list('both', projectRoot)
  const selected = agentName ? agents.filter((agent) => agent.name === agentName) : agents
  if (selected.length === 0) return agentName ? `agent ${agentName} not found` : 'no agents available'
  const parentRoute = { provider: exec.parent.options?.provider, model: exec.parent.options?.model }
  const lines = selected.map((agent) => {
    const spec = agent.model ?? deps.config.agentOverrides?.[agent.name]?.model ?? deps.config.defaultModel
    const thinking = agent.thinking ?? deps.config.agentOverrides?.[agent.name]?.thinking ?? deps.config.defaultThinking
    const model = spec ?? parentRoute.model ?? '(inherit parent)'
    const provider = spec?.includes('/') ? spec.split('/')[0] : parentRoute.provider
    return `- ${agent.name}: model=${model}${provider ? ` provider=${provider}` : ''}${thinking !== undefined ? ` thinking=${thinking}` : ''}`
  })
  return `Subagent model mapping:\n${lines.join('\n')}\n\nPrecedence: run override → agent frontmatter → agentOverrides → defaultModel → parent session model.`
}
