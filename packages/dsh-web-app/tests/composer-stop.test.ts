import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STOP_ARM_WINDOW_MS,
  advanceEsc,
  primaryActionOf,
} from '../web/src/components/composer-stop.ts'

test('STOP_ARM_WINDOW_MS 是 1 秒窗口', () => {
  assert.equal(STOP_ARM_WINDOW_MS, 1_000)
})

test('advanceEsc：未按 Esc 一律解除布防且不停止', () => {
  assert.deepEqual(advanceEsc(true, false), { armed: false, stop: false })
  assert.deepEqual(advanceEsc(false, false), { armed: false, stop: false })
})

test('advanceEsc：单次 Esc 只布防，绝不直接停止', () => {
  assert.deepEqual(advanceEsc(false, true), { armed: true, stop: false })
})

test('advanceEsc：布防窗口内第二次 Esc 才停止并解除', () => {
  assert.deepEqual(advanceEsc(true, true), { armed: false, stop: true })
})

test('advanceEsc：窗口内第三下 Esc 重新布防（不连续 stop）', () => {
  // 第二次已 stop 并把 armed 置 false，第三次 Esc 视同新的第一次 → 只布防。
  assert.deepEqual(advanceEsc(false, true), { armed: true, stop: false })
})

test('primaryActionOf：idle 恒为普通发送', () => {
  assert.equal(primaryActionOf({ running: false, isEmpty: true, armed: false }), 'send')
  assert.equal(primaryActionOf({ running: false, isEmpty: false, armed: false }), 'send')
})

test('primaryActionOf：running 且输入空 → 停止', () => {
  assert.equal(primaryActionOf({ running: true, isEmpty: true, armed: false }), 'stop')
})

test('primaryActionOf：running 且输入非空 → steer（停止按钮变发送）', () => {
  assert.equal(primaryActionOf({ running: true, isEmpty: false, armed: false }), 'steer')
})

test('primaryActionOf：armed 只对 running 生效，覆盖 steer/stop 显示 Esc', () => {
  assert.equal(primaryActionOf({ running: true, isEmpty: true, armed: true }), 'esc')
  assert.equal(primaryActionOf({ running: true, isEmpty: false, armed: true }), 'esc')
  // idle 时 armed 无意义 → 回到普通发送。
  assert.equal(primaryActionOf({ running: false, isEmpty: false, armed: true }), 'send')
})
