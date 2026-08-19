import test from 'node:test'
import assert from 'node:assert/strict'

import {
  isCompactionOnlyContent,
  isContextOnlyContent,
} from '../web/src/components/assistant-ui/thread-message-model.ts'

test('context-only rendering never hides a joined assistant suffix', () => {
  assert.equal(isContextOnlyContent([
    { type: 'data', name: 'dsh-context' },
  ]), true)
  assert.equal(isContextOnlyContent([
    { type: 'data', name: 'dsh-context' },
    { type: 'reasoning' },
  ]), false)
  assert.equal(isContextOnlyContent([
    { type: 'data', name: 'dsh-context' },
    { type: 'text' },
    { type: 'indicator' },
  ]), false)
})

test('compaction-only rendering does not swallow mixed assistant content', () => {
  assert.equal(isCompactionOnlyContent([
    { type: 'data', name: 'dsh-compaction' },
  ]), true)
  assert.equal(isCompactionOnlyContent([
    { type: 'data', name: 'dsh-compaction' },
    { type: 'text' },
  ]), false)
})
