import test from 'node:test'
import assert from 'node:assert/strict'

import { KeyedEpochGuard } from '../web/src/dsh/epoch.ts'

test('KeyedEpochGuard: only the latest-started operation is current (latest-wins)', () => {
  const guard = new KeyedEpochGuard()

  // preset A 的慢请求先发起。
  const a = guard.begin('session-1')
  assert.equal(guard.isCurrent('session-1', a), true)
  // preset B 的强刷后发起：A 即刻过期，B 成为最新。
  const b = guard.begin('session-1')
  assert.equal(guard.isCurrent('session-1', b), true)
  // A 晚返回时已不再 current，不得覆盖新 preset 的目录。
  assert.equal(guard.isCurrent('session-1', a), false)

  // 又一轮（preset C）过后，B 同样过期。
  const c = guard.begin('session-1')
  assert.equal(guard.isCurrent('session-1', a), false)
  assert.equal(guard.isCurrent('session-1', b), false)
  assert.equal(guard.isCurrent('session-1', c), true)
})

test('KeyedEpochGuard: epochs are keyed per session, not shared', () => {
  const guard = new KeyedEpochGuard()
  const s1a = guard.begin('session-1')
  const s2a = guard.begin('session-2')
  const s1b = guard.begin('session-1')

  assert.equal(guard.isCurrent('session-1', s1b), true)
  assert.equal(guard.isCurrent('session-1', s1a), false)
  // session-2 的 epoch 不受 session-1 的新 begin 影响。
  assert.equal(guard.isCurrent('session-2', s2a), true)

  const s2b = guard.begin('session-2')
  assert.equal(guard.isCurrent('session-2', s2a), false)
  assert.equal(guard.isCurrent('session-2', s2b), true)
})

test('KeyedEpochGuard: unknown keys and bogus epochs are never current', () => {
  const guard = new KeyedEpochGuard()
  const e = guard.begin('session-1')
  guard.begin('session-1')
  assert.equal(guard.isCurrent('session-1', e), false)
  // 从未 begin 过的 key：任何 epoch 都非 current。
  assert.equal(guard.isCurrent('never-begun', 1), false)
})
