import test from 'node:test'
import assert from 'node:assert/strict'

import { queuePartsOf } from '../web/src/dsh/stream.ts'

test('queue content keeps images scoped to their own steering occurrence', () => {
  const first = queuePartsOf([
    { type: 'text', text: 'first' },
    { type: 'image', attachment: { id: 'image-first', mediaType: 'image/png', name: 'first.png' } },
  ])
  const second = queuePartsOf([
    { type: 'text', text: 'second' },
    { type: 'image', attachment: { id: 'image-second', mediaType: 'image/jpeg', name: 'second.jpg' } },
  ])

  assert.deepEqual(first, [
    { type: 'text', text: 'first' },
    { type: 'image', attachmentId: 'image-first', mediaType: 'image/png', name: 'first.png' },
  ])
  assert.deepEqual(second, [
    { type: 'text', text: 'second' },
    { type: 'image', attachmentId: 'image-second', mediaType: 'image/jpeg', name: 'second.jpg' },
  ])
  assert.notEqual(first[1], second[1])
})
