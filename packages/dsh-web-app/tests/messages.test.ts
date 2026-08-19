import test from 'node:test'
import assert from 'node:assert/strict'

import { foldEvent, foldHistory } from '../web/src/dsh/messages.ts'

const event = (seq: number, type: string, data: unknown) => ({ type, seq, time: seq * 100, data })

test('only source.kind=user becomes a user message', () => {
  const user = foldEvent([], event(1, 'user/message', {
    id: 'u1',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '/unknown value' }],
  }))
  assert.equal(user?.messages[0]?.role, 'user')
  assert.deepEqual(user?.messages[0]?.parts, [{ type: 'text', text: '/unknown value' }])

  const injected = foldEvent([], event(2, 'user/message', {
    id: 'ctx1',
    source: { kind: 'skill-invocation', name: 'review-pr' },
    content: [{ type: 'text', text: 'full injected context' }],
  }))
  assert.equal(injected?.messages[0]?.role, 'assistant')
  assert.deepEqual(injected?.messages[0]?.parts, [{
    type: 'context',
    label: 'review-pr',
    text: 'full injected context',
  }])
})

test('user-typed bare slash text stays a user bubble (skill prompt is not a host command node)', () => {
  const user = foldEvent([], event(4, 'user/message', {
    id: 'u-slash',
    source: { kind: 'user' },
    content: [{ type: 'text', text: '/review-pr --base main' }],
  }))
  assert.equal(user?.messages[0]?.role, 'user')
  assert.deepEqual(user?.messages[0]?.parts, [{ type: 'text', text: '/review-pr --base main' }])
})

test('replacement-surface user messages are model-only and not rendered as user messages', () => {
  const replacement = foldEvent([], {
    ...event(3, 'user/message', {
      id: 'checkpoint',
      source: { kind: 'plugin', plugin: 'compact' },
      content: [{ type: 'text', text: 'replacement checkpoint' }],
    }),
    surfaceOp: { op: 'replace', start: 1, end: 2 },
  })
  assert.equal(replacement, null)
})

test('command lifecycle is one assistant command node, never a user bubble', () => {
  const running = foldEvent([], event(10, 'command/run', {
    commandId: 'cmd-1',
    name: 'goal',
    args: ' ship it',
    source: { kind: 'user' },
  }))
  assert.equal(running?.messages.length, 1)
  assert.equal(running?.messages[0]?.role, 'assistant')
  assert.deepEqual(running?.messages[0]?.parts, [{
    type: 'command',
    commandId: 'cmd-1',
    name: 'goal',
    args: ' ship it',
    outcome: null,
  }])

  const done = foldEvent(running!.messages, event(11, 'command/done', {
    commandId: 'cmd-1',
    kind: 'success',
    text: 'Goal created',
    sourceEventSeq: 9,
  }))
  assert.equal(done?.messages.length, 1)
  assert.deepEqual(done?.messages[0]?.parts, [{
    type: 'command',
    commandId: 'cmd-1',
    name: 'goal',
    args: ' ship it',
    outcome: { kind: 'success', text: 'Goal created', sourceEventSeq: 9 },
  }])
})

test('command/done can reconstruct a windowed lifecycle without command/run', () => {
  const done = foldEvent([], event(20, 'command/done', {
    commandId: 'windowed',
    kind: 'error',
    text: 'failed',
  }))
  assert.equal(done?.messages[0]?.role, 'assistant')
  assert.deepEqual(done?.messages[0]?.parts, [{
    type: 'command',
    commandId: 'windowed',
    name: null,
    args: null,
    outcome: { kind: 'error', text: 'failed' },
  }])
})

test('automatic compaction renders one checkpoint marker with correlated summary stats', () => {
  const messages = foldHistory([
    event(1, 'user/message', {
      id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'old history' }],
    }),
    event(2, 'compaction/summary', {
      compactionId: 'compact-auto',
      summary: [{ type: 'text', text: '## Resume\n\nKeep this context.' }],
      shadowedSeqs: [1],
      shadowedTokenCount: 42,
    }),
    {
      ...event(3, 'user/message', {
        source: { kind: 'plugin', plugin: 'compact', compactionId: 'compact-auto' },
        content: [{ type: 'text', text: '<context_checkpoint>hidden</context_checkpoint>' }],
      }),
      surfaceOp: { op: 'replace', start: 1, end: 1 },
    },
  ])

  assert.equal(messages.length, 2)
  assert.deepEqual(messages[1]?.parts, [{
    type: 'compaction',
    compactionId: 'compact-auto',
    summary: '## Resume\n\nKeep this context.',
    shadowedItemCount: 1,
    shadowedTokenCount: 42,
  }])
  assert.equal(messages[1]?.seq, 3)
})

test('manual compact merges checkpoint evidence into its command node', () => {
  const messages = foldHistory([
    event(10, 'command/run', { commandId: 'cmd-compact', name: 'compact', args: '' }),
    event(11, 'compaction/summary', {
      compactionId: 'compact-manual',
      sourceCommandId: 'cmd-compact',
      summary: [{ type: 'text', text: 'Retained facts.' }],
      shadowedSeqs: [1, 2, 4],
      shadowedTokenCount: 108331,
    }),
    {
      ...event(12, 'user/message', {
        source: {
          kind: 'plugin', plugin: 'compact', compactionId: 'compact-manual', sourceCommandId: 'cmd-compact',
        },
        content: [{ type: 'text', text: 'hidden checkpoint' }],
      }),
      surfaceOp: { op: 'replace', start: 1, end: 4 },
    },
    event(13, 'command/done', {
      commandId: 'cmd-compact', kind: 'success', text: 'Compacted 3 history items (~108331 tokens).',
    }),
  ])

  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0]?.parts, [{
    type: 'command',
    commandId: 'cmd-compact',
    name: 'compact',
    args: '',
    outcome: { kind: 'success', text: 'Compacted 3 history items (~108331 tokens).' },
    compaction: {
      type: 'compaction',
      compactionId: 'compact-manual',
      summary: 'Retained facts.',
      shadowedItemCount: 3,
      shadowedTokenCount: 108331,
    },
  }])
})

test('foldHistory sorts by seq and drops duplicate replay events', () => {
  const messages = foldHistory([
    event(2, 'command/done', { commandId: 'x', kind: 'success', text: 'done' }),
    event(1, 'command/run', { commandId: 'x', name: 'compact' }),
    event(1, 'command/run', { commandId: 'x', name: 'wrong duplicate' }),
  ])
  assert.equal(messages.length, 1)
  assert.deepEqual(messages[0]?.parts, [{
    type: 'command',
    commandId: 'x',
    name: 'compact',
    args: null,
    outcome: { kind: 'success', text: 'done' },
  }])
})
