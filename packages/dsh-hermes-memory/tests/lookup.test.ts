import { test } from 'node:test'
import assert from 'node:assert/strict'

import { normalizeMemoryLookupText } from '../src/store/memory-lookup.ts'

test('normalizeMemoryLookupText trims and keeps plain text', () => {
  assert.equal(normalizeMemoryLookupText('  use pnpm  '), 'use pnpm')
  assert.equal(normalizeMemoryLookupText(''), '')
})

test('normalizeMemoryLookupText strips scope and target prefixes from search lines', () => {
  assert.equal(
    normalizeMemoryLookupText('🧠 scope=global [target=memory] use pnpm not npm'),
    'use pnpm not npm',
  )
  assert.equal(
    normalizeMemoryLookupText('⚠️ scope=project:my-repo [target=project] [correction] use pnpm'),
    '[correction] use pnpm',
  )
  // "[target=...] [category]" 前缀对会被整段剥掉（与上游一致）
  assert.equal(
    normalizeMemoryLookupText('[target=failure] [insight] auth0 handles refresh'),
    'auth0 handles refresh',
  )
})

test('normalizeMemoryLookupText keeps first non-empty line', () => {
  assert.equal(
    normalizeMemoryLookupText('\n\nfirst line\nsecond line'),
    'first line',
  )
})
