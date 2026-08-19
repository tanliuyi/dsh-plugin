import test from 'node:test'
import assert from 'node:assert/strict'

import { ConversationFold, type FoldableSessionEvent } from '../web/src/dsh/messages.ts'

const event = (seq: number, type: string, data: unknown): FoldableSessionEvent => ({
  seq,
  type,
  time: seq * 100,
  data,
})

const statusPart = (folder: ConversationFold) => {
  const message = folder.getMessages().find((item) => item.id === 'generation-status-4-2')
  const part = message?.parts[0]
  assert.equal(part?.type, 'generation-status')
  return part
}

test('finish error is rendered and automatic retry updates the same status row', () => {
  const folder = new ConversationFold()
  folder.fold(event(1, 'assistant/chunk', {
    turn: 4,
    step: 2,
    chunk: {
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'stream timed out', code: 'TIMEOUT' } },
    },
  }))

  const failed = statusPart(folder)
  assert.equal(failed.state, 'error')
  assert.equal(failed.title, 'Request failed')
  assert.match(failed.detail, /stream timed out.*TIMEOUT/)

  folder.fold(event(2, 'llm/retry', {
    turn: 4,
    step: 2,
    retry: 1,
    maxRetries: 2,
    failure: { message: 'stream timed out', code: 'TIMEOUT' },
  }))

  const retrying = statusPart(folder)
  assert.equal(retrying.state, 'retrying')
  assert.equal(retrying.retry, 1)
  assert.equal(retrying.maxRetries, 2)
  assert.equal(folder.getMessages().filter((item) => item.id === 'generation-status-4-2').length, 1)
})

test('new text after a retry removes the transient status row', () => {
  const folder = new ConversationFold()
  folder.fold(event(1, 'llm/retry', {
    turn: 4,
    step: 2,
    retry: 1,
    maxRetries: 2,
    failure: { message: 'temporary failure' },
  }))
  folder.fold(event(2, 'assistant/chunk', {
    turn: 4,
    step: 2,
    chunk: { type: 'text-delta', index: 0, text: 'Recovered' },
  }))

  assert.equal(folder.getMessages().some((item) => item.id === 'generation-status-4-2'), false)
  const partial = folder.getMessages().find((item) => item.id === 'partial-4-2')
  assert.equal(partial?.parts[0]?.type, 'text')
  assert.equal(partial?.parts[0]?.type === 'text' ? partial.parts[0].text : '', 'Recovered')
})

test('final retry failure remains visible when no later retry event arrives', () => {
  const folder = new ConversationFold()
  folder.fold(event(1, 'llm/retry', {
    turn: 4,
    step: 2,
    retry: 2,
    maxRetries: 2,
    failure: { message: 'temporary failure' },
  }))
  folder.fold(event(2, 'assistant/chunk', {
    turn: 4,
    step: 2,
    chunk: {
      type: 'finish',
      reason: { kind: 'error', failure: { message: 'request exhausted retries', code: 'TIMEOUT' } },
    },
  }))

  const failed = statusPart(folder)
  assert.equal(failed.state, 'error')
  assert.match(failed.detail, /exhausted retries/)
})
