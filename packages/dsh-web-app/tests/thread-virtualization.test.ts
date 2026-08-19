import test from 'node:test'
import assert from 'node:assert/strict'

import {
  buildThreadTurns,
  mergeSelectedVirtualIndexes,
  shouldPrefetchOlderHistory,
  stabilizeThreadTurnIds,
} from '../web/src/components/assistant-ui/thread-virtualization.ts'

test('history prefetch starts before reaching the top', () => {
  assert.equal(shouldPrefetchOlderHistory(1_201, 800), false)
  assert.equal(shouldPrefetchOlderHistory(1_200, 800), true)
  assert.equal(shouldPrefetchOlderHistory(800, 400), true)
  assert.equal(shouldPrefetchOlderHistory(801, 400), false)
})

test('buildThreadTurns starts a turn at each user message', () => {
  assert.deepEqual(buildThreadTurns([
    { id: 'context', role: 'system' },
    { id: 'u1', role: 'user' },
    { id: 'a1', role: 'assistant' },
    { id: 'a2', role: 'assistant' },
    { id: 'u2', role: 'user' },
    { id: 'a3', role: 'assistant' },
  ]), [
    { id: 'context', messageIds: ['context'] },
    { id: 'u1', messageIds: ['u1', 'a1', 'a2'] },
    { id: 'u2', messageIds: ['u2', 'a3'] },
  ])
})

test('stabilizeThreadTurnIds reuses a surviving member key after snapshot replacement', () => {
  const previous = [
    { id: 'u1', messageIds: ['u1', 'a1'] },
    { id: 'u2', messageIds: ['u2', 'a2'] },
  ]
  const current = [
    { id: 'replacement-1', messageIds: ['replacement-1', 'a1'] },
    { id: 'replacement-2', messageIds: ['replacement-2', 'a2'] },
  ]

  assert.deepEqual(stabilizeThreadTurnIds(previous, current), [
    { id: 'u1', messageIds: ['replacement-1', 'a1'] },
    { id: 'u2', messageIds: ['replacement-2', 'a2'] },
  ])
})

test('mergeSelectedVirtualIndexes keeps a bounded selected range mounted', () => {
  assert.deepEqual(
    mergeSelectedVirtualIndexes([0, 1, 8, -1, 12], { start: 3, end: 6 }, 10),
    [0, 1, 3, 4, 5, 6, 8],
  )
  assert.deepEqual(
    mergeSelectedVirtualIndexes([2], { start: -4, end: 20 }, 4),
    [0, 1, 2, 3],
  )
})
