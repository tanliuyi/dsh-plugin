/**
 * tool-budget 单元测试（对齐上游 pi-subagents src/runs/shared/tool-budget.ts
 * 的纯函数语义；dsh 运行期接线在 spawn.ts，经 tool/call 事件计数与提示）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TOOL_BUDGET_BLOCK,
  initialToolBudgetState,
  normalizeToolBudgetBlock,
  shouldBlockToolForBudget,
  toolBudgetBlockedMessage,
  toolBudgetSoftNudge,
  toolBudgetState,
  validateToolBudgetConfig,
} from '../src/runs/tool-budget.ts'

test('normalizeToolBudgetBlock: 缺省与 * ', () => {
  assert.deepEqual(normalizeToolBudgetBlock(undefined), [...DEFAULT_TOOL_BUDGET_BLOCK])
  assert.equal(normalizeToolBudgetBlock('*'), '*')
  assert.deepEqual(normalizeToolBudgetBlock(['read', 'bash', 'read']), ['read', 'bash'])
})

test('validateToolBudgetConfig: 非法形状报错', () => {
  assert.match(validateToolBudgetConfig('x').error ?? '', /object with hard/)
  assert.match(validateToolBudgetConfig({ hard: 0 }).error ?? '', /hard must be an integer >= 1/)
  assert.match(validateToolBudgetConfig({ hard: 1, soft: 0 }).error ?? '', /soft must be an integer >= 1/)
  assert.match(validateToolBudgetConfig({ hard: 1, soft: 2 }).error ?? '', /soft must be <= toolBudget\.hard/)
  assert.match(validateToolBudgetConfig({ hard: 2, block: [] }).error ?? '', /at least one tool name/)
  assert.match(validateToolBudgetConfig({ hard: 2, block: [''] }).error ?? '', /non-empty tool names/)
})

test('validateToolBudgetConfig: 合法配置', () => {
  const r = validateToolBudgetConfig({ hard: 5, soft: 3 })
  assert.equal(r.budget?.hard, 5)
  assert.equal(r.budget?.soft, 3)
  assert.deepEqual(r.budget?.block, [...DEFAULT_TOOL_BUDGET_BLOCK])
  const star = validateToolBudgetConfig({ hard: 2, block: '*' })
  assert.equal(star.budget?.block, '*')
})

test('initialToolBudgetState: 初始状态', () => {
  const s = initialToolBudgetState({ hard: 3, block: '*' })
  assert.equal(s.toolCount, 0)
  assert.equal(s.outcome, 'within-budget')
})

test('toolBudgetState: soft/hard 判定', () => {
  const budget = { hard: 3, soft: 2, block: '*' as const }
  assert.equal(toolBudgetState(budget, 1).outcome, 'within-budget')
  assert.equal(toolBudgetState(budget, 2).outcome, 'soft-reached')
  assert.equal(toolBudgetState(budget, 3).outcome, 'soft-reached')
  assert.equal(toolBudgetState(budget, 4).outcome, 'hard-blocked')
  assert.equal(toolBudgetState(budget, 4, 'read').blockedTool, 'read')
})

test('shouldBlockToolForBudget: block 判定', () => {
  const star = { hard: 2, block: '*' as const }
  assert.equal(shouldBlockToolForBudget(star, 'read', 3), true)
  assert.equal(shouldBlockToolForBudget(star, 'read', 2), false)
  const list = { hard: 2, block: ['read'] as const }
  assert.equal(shouldBlockToolForBudget(list, 'read', 3), true)
  assert.equal(shouldBlockToolForBudget(list, 'bash', 3), false)
})

test('消息文案对齐上游', () => {
  const budget = { hard: 4, soft: 2, block: ['read'] as const }
  assert.match(toolBudgetSoftNudge(budget, 2), /soft limit reached after 2 tool calls \(soft 2, hard 4\)/)
  assert.match(toolBudgetBlockedMessage(budget, 'read', 5), /hard limit reached after 5 tool calls \(hard 4\).*'read' tool is blocked/)
})
