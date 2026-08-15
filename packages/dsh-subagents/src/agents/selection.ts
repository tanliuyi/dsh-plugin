/**
 * Agent 选择：先尝试 LLM 判断（ctx.llm），失败/无 LLM 时用任务关键词启发式。
 * 对应 pi-subagents 的 llm-intent-arbiter 简化版。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentConfig } from '../types.ts'
import { resolveLlmRoute, streamText } from '../llm.ts'

/** 关键词 → agent 的启发式规则（按顺序匹配）。 */
const KEYWORD_RULES: Array<{ agent: string; keywords: string[] }> = [
  { agent: 'reviewer', keywords: ['review', 'check my work', 'code review', 'critique', 'audit', 'pr review', 'review this diff', 'review this change', 'double-check', 'correctness'] },
  { agent: 'oracle', keywords: ['oracle', 'second opinion', 'challenge assumptions', 'what am i missing', 'advice', 'advisor', 'consult', 'sanity check', 'decision', 'risk'] },
  { agent: 'researcher', keywords: ['research', 'search the web', 'find sources', 'investigate', 'look up', 'latest', 'docs', 'documentation', 'benchmark', 'spec'] },
  { agent: 'scout', keywords: ['scout', 'recon', 'explore', 'understand the code', 'map the code', 'where is', 'how does this work', 'codebase', 'entry points', 'get context'] },
  { agent: 'worker', keywords: ['implement', 'fix', 'write', 'build', 'refactor', 'add', 'create', 'update the code', 'edit', 'change', 'make', 'develop', 'apply'] },
]

function heuristicChoice(task: string): string | undefined {
  const lower = task.toLowerCase()
  let best: { agent: string; score: number } | undefined
  for (const rule of KEYWORD_RULES) {
    const score = rule.keywords.reduce((sum, keyword) => (lower.includes(keyword) ? sum + 1 : sum), 0)
    if (score > 0 && (!best || score > best.score)) best = { agent: rule.agent, score }
  }
  return best?.agent
}

/** 把候选名限制到可用 agent 集合（含别名）。 */
function clampChoice(agent: string | undefined, agents: AgentConfig[]): AgentConfig | undefined {
  if (!agent) return undefined
  const names = new Set(agents.map((a) => a.name))
  if (names.has(agent)) return agents.find((a) => a.name === agent)
  const aliases = agents.filter((a) => a.aliases?.includes(agent.toLowerCase()))
  if (aliases.length === 1) return aliases[0]
  return undefined
}

/**
 * 为任务选择一个 agent。优先 LLM；LLM 不可用或失败时用启发式。
 */
export async function selectAgent(
  ctx: Context,
  task: string,
  agents: AgentConfig[],
  opts: { prefer?: string; timeoutMs?: number; agentRoute?: { provider?: string; model?: string } } = {},
): Promise<{ agent?: AgentConfig; viaLlm: boolean; error?: string }> {
  if (agents.length === 0) return { agent: undefined, viaLlm: false, error: 'no agents available' }
  if (opts.prefer) {
    const preferred = clampChoice(opts.prefer.toLowerCase(), agents)
    if (preferred) return { agent: preferred, viaLlm: false }
  }

  const route = await resolveLlmRoute(ctx, undefined, opts.agentRoute)
  if (route) {
    const agent = await chooseViaLlm(ctx, route, task, agents)
    if (agent) return { agent, viaLlm: true }
  }
  const heuristic = clampChoice(heuristicChoice(task), agents)
  if (heuristic) return { agent: heuristic, viaLlm: false }
  return { agent: undefined, viaLlm: false, error: 'could not select an agent for the task' }
}

async function chooseViaLlm(
  ctx: Context,
  route: { provider: string; model: string; reasoningEffort?: string },
  task: string,
  agents: AgentConfig[],
): Promise<AgentConfig | undefined> {
  const catalog = agents.map((agent) => `- ${agent.name}: ${agent.description || 'no description'}`).join('\n')
  const system = 'You are an agent router. Choose exactly one agent from the catalog for the given task. Respond with a single JSON object: {"agent": "<exact name>"}. No prose.'
  const text = await streamText(ctx, {
    provider: route.provider,
    model: route.model,
    reasoningEffort: route.reasoningEffort,
    system,
    user: `Catalog:\n${catalog}\n\nTask: ${task.slice(0, 4000)}`,
  })
  if (!text) return undefined
  const match = text.match(/"agent"\s*:\s*"([^"]+)"/)
  const name = match?.[1]
  if (!name) return undefined
  return clampChoice(name, agents)
}
