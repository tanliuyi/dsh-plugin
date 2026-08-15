import { test } from 'node:test'
import assert from 'node:assert/strict'

import { guide, guideTopics } from '../src/guide.ts'

test('guide: all topics resolve from the package docs dir', async () => {
  for (const topic of guideTopics().filter((t) => t !== 'overview')) {
    const text = await guide(topic)
    assert.ok(!text.includes('not shipped'), `guide(${topic}) must load package docs`)
    assert.ok(text.length > 100, `guide(${topic}) must return real content`)
  }
})

test('guide: overview is the built-in summary', async () => {
  const text = await guide('overview')
  assert.ok(text.includes('dsh-subagents'))
})

test('guide: unknown topic lists valid topics', async () => {
  const text = await guide('no-such-topic')
  assert.ok(text.includes('Valid topics'))
})
