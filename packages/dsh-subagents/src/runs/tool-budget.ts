/**
 * Tool budget（对齐上游 pi-subagents src/runs/shared/tool-budget.ts）。
 *
 * 语义：soft 达到后提示 finalize（steer nudge）；超过 hard 后 block 列表中的
 * 工具被拒绝。dsh 无 per-tool 拦截能力：计数与 soft/hard 提示经全局 tool/call
 * 事件实现（spawn.ts），hard 后的 block 以 steer 告知子代理「工具已禁止」近似，
 * 无法真正阻止调用（README 已如实声明）。
 */

export const DEFAULT_TOOL_BUDGET_BLOCK = ['read', 'grep', 'find', 'ls'] as const

export interface ResolvedToolBudget {
  hard: number
  soft?: number
  block: '*' | string[]
}

export interface ToolBudgetState extends ResolvedToolBudget {
  toolCount: number
  outcome: 'within-budget' | 'soft-reached' | 'hard-blocked'
  softReachedAt?: number
  hardReachedAt?: number
  blockedTool?: string
}

export function normalizeToolBudgetBlock(block: unknown): '*' | string[] {
  if (block === '*') return '*'
  if (block === undefined) return [...DEFAULT_TOOL_BUDGET_BLOCK]
  return [...new Set((block as string[]).map((tool) => tool.trim()).filter(Boolean))]
}

export function validateToolBudgetConfig(
  raw: unknown,
  label = 'toolBudget',
  options: { minimumHard?: 0 | 1 } = {},
): { budget?: ResolvedToolBudget; error?: string } {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: `${label} must be an object with hard and optional soft/block.` }
  const value = raw as { hard?: unknown; soft?: unknown; block?: unknown }
  const minimumHard = options.minimumHard ?? 1
  if (typeof value.hard !== 'number' || !Number.isInteger(value.hard) || value.hard < minimumHard) {
    return { error: `${label}.hard must be an integer >= ${minimumHard}.` }
  }
  if (value.soft !== undefined && (typeof value.soft !== 'number' || !Number.isInteger(value.soft) || value.soft < 1)) {
    return { error: `${label}.soft must be an integer >= 1 when provided.` }
  }
  if (value.soft !== undefined && value.soft > value.hard) {
    return { error: `${label}.soft must be <= ${label}.hard.` }
  }
  if (value.block !== undefined && value.block !== '*') {
    if (!Array.isArray(value.block)) return { error: `${label}.block must be "*" or an array of tool names.` }
    if (value.block.length === 0) return { error: `${label}.block must contain at least one tool name.` }
    for (const item of value.block) {
      if (typeof item !== 'string' || !item.trim()) return { error: `${label}.block must contain non-empty tool names.` }
    }
  }
  return { budget: { hard: value.hard as number, ...(value.soft !== undefined ? { soft: value.soft as number } : {}), block: normalizeToolBudgetBlock(value.block) } }
}

export function initialToolBudgetState(budget: ResolvedToolBudget): ToolBudgetState {
  return { ...budget, toolCount: 0, outcome: 'within-budget' }
}

export function toolBudgetState(budget: ResolvedToolBudget, toolCount: number, blockedTool?: string): ToolBudgetState {
  const overHard = toolCount > budget.hard
  const overSoft = budget.soft !== undefined && toolCount >= budget.soft
  return {
    ...budget,
    toolCount,
    outcome: overHard ? 'hard-blocked' : overSoft ? 'soft-reached' : 'within-budget',
    ...(overSoft ? { softReachedAt: budget.soft } : {}),
    ...(overHard ? { hardReachedAt: budget.hard, ...(blockedTool ? { blockedTool } : {}) } : {}),
  }
}

export function shouldBlockToolForBudget(budget: ResolvedToolBudget, toolName: string, nextToolCount: number): boolean {
  if (nextToolCount <= budget.hard) return false
  return budget.block === '*' || budget.block.includes(toolName)
}

export function toolBudgetSoftNudge(budget: ResolvedToolBudget, toolCount: number): string {
  return `Tool budget soft limit reached after ${toolCount} tool call${toolCount === 1 ? '' : 's'} (soft ${budget.soft}, hard ${budget.hard}). Stop starting new browsing/search work and finalize from the context you already have.`
}

export function toolBudgetBlockedMessage(budget: ResolvedToolBudget, toolName: string, toolCount: number): string {
  return `Tool budget hard limit reached after ${toolCount} tool call${toolCount === 1 ? '' : 's'} (hard ${budget.hard}). The '${toolName}' tool is blocked so you can finalize from the context you already have.`
}
