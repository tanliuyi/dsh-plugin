/**
 * model-fallback 单元测试（对齐上游 pi-subagents src/runs/shared/model-fallback.ts）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildModelCandidates,
  errorText,
  formatModelAttemptNote,
  isRetryableModelFailure,
} from '../src/runs/model-fallback.ts'

test('buildModelCandidates: primary + fallbacks 去重', () => {
  assert.deepEqual(buildModelCandidates('a', ['b', 'c']), ['a', 'b', 'c'])
  assert.deepEqual(buildModelCandidates('a', ['a', 'b']), ['a', 'b'])
  assert.deepEqual(buildModelCandidates(undefined, ['b']), ['b'])
  assert.deepEqual(buildModelCandidates(undefined, undefined), [])
  assert.deepEqual(buildModelCandidates('  a  ', ['b', '']), ['a', 'b'])
})

test('isRetryableModelFailure: 可重试模式', () => {
  assert.equal(isRetryableModelFailure('Rate limit exceeded for model'), true)
  assert.equal(isRetryableModelFailure('Error 429: too many requests'), true)
  assert.equal(isRetryableModelFailure('model not found: gpt-5'), true)
  assert.equal(isRetryableModelFailure('fetch failed: connection refused'), true)
  assert.equal(isRetryableModelFailure('upstream request timed out'), true)
  assert.equal(isRetryableModelFailure('quota exceeded'), true)
})

test('isRetryableModelFailure: 非可重试（工具失败/普通错误）', () => {
  assert.equal(isRetryableModelFailure('bash failed (exit 1): npm install error'), false)
  assert.equal(isRetryableModelFailure('edit failed with exit code 2'), false)
  assert.equal(isRetryableModelFailure('user cancelled the run'), false)
  assert.equal(isRetryableModelFailure(undefined), false)
  assert.equal(isRetryableModelFailure(''), false)
})

test('errorText: 提取错误文本', () => {
  assert.equal(errorText(new Error('boom')), 'boom')
  assert.equal(errorText('plain'), 'plain')
  assert.equal(errorText({ message: 'obj' }), 'obj')
  assert.equal(errorText(42), '42')
})

test('formatModelAttemptNote: 文案对齐上游', () => {
  assert.match(formatModelAttemptNote({ model: 'm1', success: false, error: 'rate limit' }, 'm2'), /^\[fallback\] m1 failed: rate limit\. Retrying with m2\.$/)
  assert.match(formatModelAttemptNote({ model: 'm1', success: false }), /^\[fallback\] m1 failed: exit 1\.$/)
})
