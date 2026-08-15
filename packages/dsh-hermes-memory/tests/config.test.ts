import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Config, normalizeConfig } from '../src/config.ts'
import {
  DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_NUDGE_INTERVAL,
  DEFAULT_USER_CHAR_LIMIT,
} from '../src/constants.ts'

test('Config schema fills defaults', () => {
  const config = Config({})
  assert.equal(config.memoryMode, 'policy-only')
  assert.equal(config.memoryCharLimit, DEFAULT_MEMORY_CHAR_LIMIT)
  assert.equal(config.userCharLimit, DEFAULT_USER_CHAR_LIMIT)
  assert.equal(config.nudgeInterval, DEFAULT_NUDGE_INTERVAL)
  assert.equal(config.reviewEnabled, true)
  assert.equal(config.correctionDetection, true)
  assert.equal(config.memoryOverflowStrategy, 'auto-consolidate')
  assert.equal(config.autoConsolidate, true)
  assert.equal(config.consolidationTimeoutMs, DEFAULT_CONSOLIDATION_TIMEOUT_MS)
  assert.equal(config.standingInstructionsEnabled, true)
  assert.equal(config.projectsMemoryDir, 'projects-memory')
})

test('Config schema accepts overrides and validates enums', () => {
  const config = Config({
    memoryMode: 'legacy-inject',
    memoryPolicyStyle: 'compact',
    memoryOverflowStrategy: 'fifo-evict',
    llmModelOverride: 'openrouter/deepseek/deepseek-v4-flash',
  })
  assert.equal(config.memoryMode, 'legacy-inject')
  assert.equal(config.memoryPolicyStyle, 'compact')
  assert.equal(config.memoryOverflowStrategy, 'fifo-evict')

  assert.throws(() => Config({ memoryMode: 'bogus' }))
  assert.throws(() => Config({ memoryOverflowStrategy: 'bogus' }))
})

test('normalizeConfig removes empty-string overrides', () => {
  const config = normalizeConfig({
    ...Config({}),
    memoryDir: '',
    llmModelOverride: '  ',
    memoryPolicyCustomText: '',
  } as never)
  assert.equal(config.memoryDir, undefined)
  assert.equal(config.llmModelOverride, undefined)
  assert.equal(config.memoryPolicyCustomText, undefined)
})

test('normalizeConfig maps legacy autoConsolidate=false to reject', () => {
  const config = normalizeConfig({
    ...Config({ autoConsolidate: false }),
  } as never)
  assert.equal(config.memoryOverflowStrategy, 'reject')
})
