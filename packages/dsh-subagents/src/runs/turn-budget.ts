/**
 * Turn budget（对齐上游 pi-subagents src/runs/shared/turn-budget.ts）。
 * 纯函数部分逐字移植；dsh 的强制接线在 spawn.ts（全局 session/event 按
 * child 会话计数回合：soft 到达 maxTurns 时 steer 请求 wrap-up，超过
 * maxTurns + graceTurns 时 agent.cancel 中止）。
 */

export interface ResolvedTurnBudget {
  maxTurns: number
  graceTurns?: number
}

export type TurnBudgetOutcome =
  | 'within-budget'
  | 'wrap-up-requested'
  | 'termination-deferred'
  | 'exceeded'

export interface TurnBudgetState extends ResolvedTurnBudget {
  outcome: TurnBudgetOutcome
  turnCount: number
  wrapUpRequestedAtTurn?: number
  exceededAtTurn?: number
  terminationDeferredAtTurn?: number
}

export const DEFAULT_TURN_BUDGET_GRACE_TURNS = 1

export function resolveTurnBudgetConfig(
  raw: unknown,
  label = 'turnBudget',
): { turnBudget?: ResolvedTurnBudget; error?: string } {
  if (raw === undefined) return {}
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: `${label} must be an object with maxTurns and optional graceTurns.` }
  }
  const unknownField = Object.keys(raw).find((key) => key !== 'maxTurns' && key !== 'graceTurns')
  if (unknownField) return { error: `${label}.${unknownField} is not supported.` }
  const budget = raw as { maxTurns?: unknown; graceTurns?: unknown }
  if (typeof budget.maxTurns !== 'number' || !Number.isInteger(budget.maxTurns) || budget.maxTurns < 1) {
    return { error: `${label}.maxTurns must be an integer >= 1.` }
  }
  const graceTurns = budget.graceTurns ?? DEFAULT_TURN_BUDGET_GRACE_TURNS
  if (typeof graceTurns !== 'number' || !Number.isInteger(graceTurns) || graceTurns < 0) {
    return { error: `${label}.graceTurns must be an integer >= 0.` }
  }
  return { turnBudget: { maxTurns: budget.maxTurns, graceTurns } }
}

export function appendTurnBudgetSystemPrompt(
  systemPrompt: string,
  budget: { maxTurns: number; graceTurns?: number } | undefined,
): string {
  if (!budget) return systemPrompt
  const graceTurns = budget.graceTurns ?? DEFAULT_TURN_BUDGET_GRACE_TURNS
  const grace = graceTurns === 1 ? '1 additional assistant turn' : `${graceTurns} additional assistant turns`
  const block = [
    '## Turn budget',
    `This child run has a soft budget of ${budget.maxTurns} assistant turn${budget.maxTurns === 1 ? '' : 's'}.`,
    `After that, ${grace} may be allowed only for a final wrap-up.`,
    'When you approach or reach the soft budget, stop starting new tool work and return the final answer immediately.',
    'This runner uses process-mode execution, so live steering after launch may be unavailable; treat this instruction as the wrap-up request.',
    'If you continue past the soft budget plus grace turns, the supervisor may abort the process and return only partial output.',
  ].join('\n')
  return systemPrompt.trim() ? `${systemPrompt.trim()}\n\n${block}` : block
}

export function turnBudgetSoftNote(budget: ResolvedTurnBudget, turnCount: number): string {
  return `Turn budget wrap-up was requested after ${turnCount} assistant turn${turnCount === 1 ? '' : 's'} (soft limit ${budget.maxTurns}, grace ${budget.graceTurns}). Output may be partial.`
}

export function turnBudgetExceededMessage(budget: ResolvedTurnBudget, turnCount: number): string {
  return `Subagent exceeded turn budget after ${turnCount} assistant turn${turnCount === 1 ? '' : 's'} (soft limit ${budget.maxTurns} + grace ${budget.graceTurns}).`
}

export function turnBudgetDeferredNote(budget: ResolvedTurnBudget, turnCount: number): string {
  return `Turn-budget termination was deferred at ${turnCount} assistant turn${turnCount === 1 ? '' : 's'} (soft limit ${budget.maxTurns} + grace ${budget.graceTurns}) because the assistant started tool work. The run ended before another safe assistant boundary; output may be partial.`
}

export function formatTurnBudgetOutput(message: string, output: string): string {
  return output.trim()
    ? `${message}\n\nPartial output before turn-budget abort:\n${output}`
    : message
}

export function initialTurnBudgetState(budget: { maxTurns: number; graceTurns?: number }): TurnBudgetState {
  return {
    maxTurns: budget.maxTurns,
    graceTurns: budget.graceTurns ?? DEFAULT_TURN_BUDGET_GRACE_TURNS,
    outcome: 'within-budget',
    turnCount: 0,
  }
}

export function turnBudgetState(budget: ResolvedTurnBudget, turnCount: number, exceeded: boolean): TurnBudgetState {
  return {
    ...budget,
    turnCount,
    outcome: exceeded ? 'exceeded' : 'wrap-up-requested',
    wrapUpRequestedAtTurn: budget.maxTurns,
    ...(exceeded ? { exceededAtTurn: turnCount } : {}),
  }
}

export function turnBudgetDeferredState(
  budget: ResolvedTurnBudget,
  turnCount: number,
  terminationDeferredAtTurn = turnCount,
): TurnBudgetState {
  return {
    ...budget,
    turnCount,
    outcome: 'termination-deferred',
    wrapUpRequestedAtTurn: budget.maxTurns,
    terminationDeferredAtTurn,
  }
}

export function turnBudgetDecision(
  budget: ResolvedTurnBudget,
  turnCount: number,
  terminalAssistantStop: boolean,
  toolWorkActiveOrStarting: boolean,
  enforceHardLimit = false,
): 'continue' | 'defer' | 'abort' {
  const hardLimit = budget.maxTurns + (budget.graceTurns ?? DEFAULT_TURN_BUDGET_GRACE_TURNS)
  if (terminalAssistantStop || turnCount < hardLimit) return 'continue'
  if (toolWorkActiveOrStarting && !enforceHardLimit) return 'defer'
  return 'abort'
}
