import assert from 'node:assert/strict'
import test from 'node:test'
import { CompletionNotifier, formatGroupedCompletionNotices, DEFAULT_COMPLETION_BATCH_CONFIG } from '../src/runs/completion-notify.ts'

interface FakeTimer {
  fire(): void
}

/** 假时钟：手动推进 setTimeout。 */
function fakeTimers() {
  const pending: Array<{ at: number; delay: number; callback: () => void }> = []
  let nowMs = 0
  return {
    now: () => nowMs,
    timers: {
      setTimeout(callback: () => void, delayMs: number): FakeTimer {
        const entry = { at: nowMs + delayMs, delay: delayMs, callback }
        pending.push(entry)
        return entry
      },
      clearTimeout(): void { /* 简单实现：置空由调用方管理 */ },
    },
    advance(ms: number): void {
      nowMs += ms
      for (;;) {
        const due = pending.filter((entry) => entry.at <= nowMs).sort((a, b) => a.at - b.at)
        if (due.length === 0) break
        const next = due[0]!
        pending.splice(pending.indexOf(next), 1)
        next.callback()
      }
    },
  }
}

function item(jobId: string, status = 'completed'): { jobId: string; text: string } {
  return { jobId, text: `[subagents] background run ${jobId} (delegate) ${status}` }
}

test('CompletionNotifier: debounce 窗口内多条 completed 合并为一条 grouped 通知', () => {
  const fake = fakeTimers()
  const deliveries: Array<{ sessionId: string; count: number; text: string }> = []
  const notifier = new CompletionNotifier({
    deliver: (sessionId, items, text) => deliveries.push({ sessionId, count: items.length, text }),
    timers: fake.timers,
    now: fake.now,
  })
  notifier.notify('s1', item('j1'), false)
  notifier.notify('s1', item('j2'), false)
  fake.advance(DEFAULT_COMPLETION_BATCH_CONFIG.debounceMs + 10)
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0]!.count, 2)
  assert.ok(deliveries[0]!.text.includes('2 background run(s)'))
  assert.ok(deliveries[0]!.text.includes('j1'))
  assert.ok(deliveries[0]!.text.includes('j2'))
})

test('CompletionNotifier: 非 completed 绕过批量立即投递，并先 flush 已持有的批', () => {
  const fake = fakeTimers()
  const deliveries: Array<{ count: number; text: string }> = []
  const notifier = new CompletionNotifier({
    deliver: (_sessionId, items, text) => deliveries.push({ count: items.length, text }),
    timers: fake.timers,
    now: fake.now,
  })
  notifier.notify('s1', item('j1'), false) // completed 入批
  notifier.notify('s1', item('j2', 'failed'), true) // failed 立即
  assert.equal(deliveries.length, 2) // 批先 flush（1 条）+ failed 立即（1 条）
  assert.ok(deliveries[0]!.text.includes('j1'))
  assert.ok(deliveries[1]!.text.includes('j2'))
  assert.ok(deliveries[1]!.text.includes('failed'))
})

test('CompletionNotifier: maxWait 硬上限（首条起 1s）强制发出', () => {
  const fake = fakeTimers()
  const deliveries: Array<{ count: number }> = []
  const notifier = new CompletionNotifier({
    deliver: (_sessionId, items, _text) => deliveries.push({ count: items.length }),
    timers: fake.timers,
    now: fake.now,
  })
  notifier.notify('s1', item('j1'), false)
  fake.advance(DEFAULT_COMPLETION_BATCH_CONFIG.maxWaitMs + 10)
  assert.equal(deliveries.length, 1)
  assert.equal(deliveries[0]!.count, 1)
})

test('CompletionNotifier: straggler（上批发出后 2s 内）用更短窗口', () => {
  const fake = fakeTimers()
  const deliveries: Array<{ count: number }> = []
  const notifier = new CompletionNotifier({
    deliver: (_sessionId, items, _text) => deliveries.push({ count: items.length }),
    timers: fake.timers,
    now: fake.now,
  })
  notifier.notify('s1', item('j1'), false)
  fake.advance(DEFAULT_COMPLETION_BATCH_CONFIG.debounceMs + 10) // 第一批发出
  assert.equal(deliveries.length, 1)
  notifier.notify('s1', item('j2'), false) // straggler 批
  fake.advance(DEFAULT_COMPLETION_BATCH_CONFIG.stragglerDebounceMs + 10)
  assert.equal(deliveries.length, 2) // straggler 用 75ms 而不是 150ms
})

test('CompletionNotifier: enabled=false 时逐条立即投递', () => {
  const fake = fakeTimers()
  const deliveries: Array<{ count: number }> = []
  const notifier = new CompletionNotifier({
    deliver: (_sessionId, items, _text) => deliveries.push({ count: items.length }),
    timers: fake.timers,
    now: fake.now,
    config: { enabled: false },
  })
  notifier.notify('s1', item('j1'), false)
  notifier.notify('s1', item('j2'), false)
  assert.equal(deliveries.length, 2)
})

test('formatGroupedCompletionNotices: 保留 run 状态与输出尾部', () => {
  const text = formatGroupedCompletionNotices([
    { jobId: 'j1', text: '[subagents] background run j1 (delegate) failed\nOutput tail:\nboom' },
    { jobId: 'j2', text: '[subagents] background run j2 (delegate) completed' },
  ])
  assert.ok(text.includes('2 background run(s)'))
  assert.ok(text.includes('failed'))
  assert.ok(text.includes('boom'))
  assert.ok(text.includes('j2 (delegate) completed'))
})
