/**
 * turn-budget 单元测试（对齐上游 pi-subagents src/runs/shared/turn-budget.ts 的
 * 纯函数语义；dsh 运行期强制在 spawn.ts，经 session/event 计数回合）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_TURN_BUDGET_GRACE_TURNS,
  appendTurnBudgetSystemPrompt,
  formatTurnBudgetOutput,
  initialTurnBudgetState,
  resolveTurnBudgetConfig,
  turnBudgetDecision,
  turnBudgetDeferredNote,
  turnBudgetDeferredState,
  turnBudgetExceededMessage,
  turnBudgetSoftNote,
  turnBudgetState,
} from '../src/runs/turn-budget.ts'

test('resolveTurnBudgetConfig: undefined 返回空', () => {
  const r = resolveTurnBudgetConfig(undefined)
  assert.deepEqual(r, {})
})

test('resolveTurnBudgetConfig: 非法形状报错', () => {
  assert.match(resolveTurnBudgetConfig('x').error ?? '', /object with maxTurns/)
  assert.match(resolveTurnBudgetConfig([]).error ?? '', /object with maxTurns/)
  assert.match(resolveTurnBudgetConfig({ maxTurns: 1, extra: 2 }).error ?? '', /extra is not supported/)
  assert.match(resolveTurnBudgetConfig({ maxTurns: 0 }).error ?? '', /maxTurns must be an integer >= 1/)
  assert.match(resolveTurnBudgetConfig({ maxTurns: 1.5 }).error ?? '', /maxTurns must be an integer >= 1/)
  assert.match(resolveTurnBudgetConfig({ maxTurns: 2, graceTurns: -1 }).error ?? '', /graceTurns must be an integer >= 0/)
})

test('resolveTurnBudgetConfig: 合法配置', () => {
  assert.deepEqual(resolveTurnBudgetConfig({ maxTurns: 3 }), { turnBudget: { maxTurns: 3, graceTurns: 1 } })
  assert.deepEqual(resolveTurnBudgetConfig({ maxTurns: 3, graceTurns: 0 }), { turnBudget: { maxTurns: 3, graceTurns: 0 } })
})

test('appendTurnBudgetSystemPrompt: 空提示直接注入', () => {
  const out = appendTurnBudgetSystemPrompt('', { maxTurns: 2 })
  assert.match(out, /## Turn budget/)
  assert.match(out, /soft budget of 2 assistant turns/)
  assert.match(out, /1 additional assistant turn/)
})

test('appendTurnBudgetSystemPrompt: 有提示时追加', () => {
  const out = appendTurnBudgetSystemPrompt('base', { maxTurns: 1 })
  assert.ok(out.startsWith('base'))
  assert.match(out, /soft budget of 1 assistant turn/)
  assert.match(out, /1 additional assistant turn/)
  const out2 = appendTurnBudgetSystemPrompt('base', { maxTurns: 1, graceTurns: 2 })
  assert.match(out2, /2 additional assistant turns/)
})

test('appendTurnBudgetSystemPrompt: 无预算返回原文', () => {
  assert.equal(appendTurnBudgetSystemPrompt('x', undefined), 'x')
})

test('initialTurnBudgetState: 默认 grace 1', () => {
  const s = initialTurnBudgetState({ maxTurns: 4 })
  assert.equal(s.maxTurns, 4)
  assert.equal(s.graceTurns, DEFAULT_TURN_BUDGET_GRACE_TURNS)
  assert.equal(s.outcome, 'within-budget')
  assert.equal(s.turnCount, 0)
})

test('turnBudgetDecision: 软/硬边界', () => {
  const budget = { maxTurns: 3, graceTurns: 1 }
  // 未达 hard limit → continue
  assert.equal(turnBudgetDecision(budget, 3, false, false), 'continue')
  assert.equal(turnBudgetDecision(budget, 4, true, false), 'continue')
  // 达到 hard limit 且无工具工作 → abort
  assert.equal(turnBudgetDecision(budget, 4, false, false), 'abort')
  // 达到 hard limit 但有工具工作 → defer
  assert.equal(turnBudgetDecision(budget, 4, false, true), 'defer')
  // enforceHardLimit → 不 defer
  assert.equal(turnBudgetDecision(budget, 4, false, true, true), 'abort')
})

test('turnBudgetState / turnBudgetDeferredState / 消息', () => {
  const budget = { maxTurns: 2, graceTurns: 1 }
  const s = turnBudgetState(budget, 3, true)
  assert.equal(s.outcome, 'exceeded')
  assert.equal(s.exceededAtTurn, 3)
  assert.equal(s.wrapUpRequestedAtTurn, 2)
  const d = turnBudgetDeferredState(budget, 3)
  assert.equal(d.outcome, 'termination-deferred')
  assert.equal(d.terminationDeferredAtTurn, 3)
  assert.match(turnBudgetSoftNote(budget, 2), /wrap-up was requested after 2 assistant turns/)
  assert.match(turnBudgetExceededMessage(budget, 3), /exceeded turn budget after 3 assistant turns/)
  assert.match(turnBudgetDeferredNote(budget, 3), /termination was deferred at 3 assistant turns/)
})

test('formatTurnBudgetOutput: 有输出时附带部分输出', () => {
  assert.equal(formatTurnBudgetOutput('msg', ''), 'msg')
  const out = formatTurnBudgetOutput('msg', 'partial')
  assert.ok(out.startsWith('msg'))
  assert.match(out, /Partial output before turn-budget abort:/)
  assert.match(out, /partial/)
})
