/**
 * activeTurns 水合（turn 边界折叠）的单元测试：不启动 DSH，直接以结构化
 * 假会话验证 latestTurnBoundary 与 SessionState.hydrate，并确认增量 listener
 * 路径（applyTurnEvent）行为保持不变。对应 src/runs/execution.ts。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  latestTurnBoundary,
  SessionState,
  type TurnStateReader,
} from '../src/runs/execution.ts'

type Ev = { type: string }

function session(id: string, events: Array<Ev> = []): TurnStateReader {
  return { id, events }
}

test('latestTurnBoundary: 开日志（start 后有非边界事件）→ open', () => {
  assert.equal(latestTurnBoundary([
    { type: 'turn/start' },
    { type: 'user/message' },
    { type: 'assistant/message' },
    { type: 'tool/result' },
  ]), 'open')
  // 单独 start 也是 open
  assert.equal(latestTurnBoundary([{ type: 'turn/start' }]), 'open')
})

test('latestTurnBoundary: 关闭日志（end 在最后）→ closed', () => {
  assert.equal(latestTurnBoundary([
    { type: 'turn/start' },
    { type: 'user/message' },
    { type: 'turn/end' },
  ]), 'closed')
  assert.equal(latestTurnBoundary([{ type: 'turn/end' }]), 'closed')
})

test('latestTurnBoundary: 多回合取最近的边界', () => {
  // 最近边界是 end → closed
  assert.equal(latestTurnBoundary([
    { type: 'turn/start' },
    { type: 'turn/end' },
    { type: 'turn/start' },
    { type: 'turn/end' },
  ]), 'closed')
  // 第二轮 start 打开、尚未 end → open
  assert.equal(latestTurnBoundary([
    { type: 'turn/start' },
    { type: 'turn/end' },
    { type: 'turn/start' },
  ]), 'open')
})

test('latestTurnBoundary: 无任何回合边界 → none', () => {
  assert.equal(latestTurnBoundary([]), 'none')
  assert.equal(latestTurnBoundary([
    { type: 'user/message' },
    { type: 'assistant/message' },
  ]), 'none')
})

test('SessionState.hydrate: 按回合边界重建 activeTurns', () => {
  const state = new SessionState()
  state.hydrate([
    session('open-1', [{ type: 'turn/start' }, { type: 'user/message' }]),
    session('closed-1', [{ type: 'turn/start' }, { type: 'turn/end' }]),
    session('no-boundary', [{ type: 'user/message' }]),
    session('empty'),
  ])
  assert.equal(state.isTurnOpen('open-1'), true, 'open turn should be active')
  assert.equal(state.isTurnOpen('closed-1'), false, 'closed turn should be inactive')
  assert.equal(state.isTurnOpen('no-boundary'), false, 'no boundary should be inactive')
  assert.equal(state.isTurnOpen('empty'), false)
})

test('SessionState.hydrate: 清除陈旧 active 状态（closed/无边界/已不存活）', () => {
  const state = new SessionState()
  // 先制造陈旧 active
  state.applyTurnEvent('dead-session', 'turn/start')
  state.applyTurnEvent('now-closed', 'turn/start')
  state.applyTurnEvent('now-no-boundary', 'turn/start')
  state.applyTurnEvent('still-open', 'turn/start')
  // hydrate 后按事件日志归一
  state.hydrate([
    session('now-closed', [{ type: 'turn/start' }, { type: 'turn/end' }]),
    session('now-no-boundary', [{ type: 'user/message' }]),
    session('still-open', [{ type: 'turn/start' }, { type: 'assistant/message' }]),
  ])
  assert.equal(state.isTurnOpen('dead-session'), false, 'dead session cleared')
  assert.equal(state.isTurnOpen('now-closed'), false, 'now-closed cleared stale active')
  assert.equal(state.isTurnOpen('now-no-boundary'), false, 'no-boundary cleared stale active')
  assert.equal(state.isTurnOpen('still-open'), true)
})

test('SessionState.applyTurnEvent: 增量 listener 行为保持不变', () => {
  const state = new SessionState()
  const id = 's1'
  state.applyTurnEvent(id, 'turn/start')
  assert.equal(state.isTurnOpen(id), true)
  // 非边界事件不影响状态
  state.applyTurnEvent(id, 'user/message')
  state.applyTurnEvent(id, 'tool/result')
  assert.equal(state.isTurnOpen(id), true)
  // turn/end 关闭
  state.applyTurnEvent(id, 'turn/end')
  assert.equal(state.isTurnOpen(id), false)
  // 重复 end / 未知类型保持关闭且不抛错
  state.applyTurnEvent(id, 'turn/end')
  state.applyTurnEvent(id, 'unknown/x')
  assert.equal(state.isTurnOpen(id), false)
  // start 再次打开
  state.applyTurnEvent(id, 'turn/start')
  assert.equal(state.isTurnOpen(id), true)
  // 与 hydrate 组合：增量记录 + 幂等折叠得到同一终态
  state.hydrate([session(id, [{ type: 'turn/start' }, { type: 'turn/end' }])])
  assert.equal(state.isTurnOpen(id), false)
})