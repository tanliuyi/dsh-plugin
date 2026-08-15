import { test } from 'node:test'
import assert from 'node:assert/strict'

import { isCorrection, extractCorrectionDirective } from '../src/handlers/correction-detector.ts'

test('strong patterns always trigger', () => {
  assert.equal(isCorrection("don't do that"), true)
  assert.equal(isCorrection("please don't use npm"), true)
  assert.equal(isCorrection("I said use pnpm"), true)
  assert.equal(isCorrection("I told you not to do that"), true)
  assert.equal(isCorrection("we already discussed this"), true)
  assert.equal(isCorrection("that's not what I meant"), true)
})

test('weak patterns trigger only with directive words', () => {
  assert.equal(isCorrection('no, use yarn instead'), true)
  assert.equal(isCorrection('no, do it this way'), true)
  assert.equal(isCorrection('wrong, the test goes first'), true)
  assert.equal(isCorrection('actually, fix the test first'), true)
  assert.equal(isCorrection('no worries'), false)
  assert.equal(isCorrection('no problem'), false)
  assert.equal(isCorrection('actually looks great'), false)
  assert.equal(isCorrection('stop there'), false)
  assert.equal(isCorrection('no, I was just wondering'), false)
})

test('negative patterns suppress positives', () => {
  assert.equal(isCorrection('no thanks, that is fine'), false)
  assert.equal(isCorrection('no need to change'), false)
})

test('custom pattern overrides replace defaults', () => {
  // 空数组 = 无模式
  assert.equal(isCorrection("don't do that", { correctionStrongPatterns: [] }), false)
  // 自定义强模式
  assert.equal(
    isCorrection('please stop doing this', { correctionStrongPatterns: [/^please stop/i] }),
    true,
  )
  // 非法正则被忽略
  assert.equal(
    isCorrection("don't do that", { correctionStrongPatterns: ['[invalid'] }),
    false,
  )
})

test('extractCorrectionDirective strips starters', () => {
  assert.equal(extractCorrectionDirective('no, use pnpm instead'), 'use pnpm instead')
  assert.equal(extractCorrectionDirective("don't use npm"), 'use npm')
  assert.equal(extractCorrectionDirective('I said use pnpm'), 'use pnpm')
})
