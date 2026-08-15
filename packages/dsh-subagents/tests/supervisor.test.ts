import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SupervisorChannel } from '../src/intercom/supervisor.ts'

function stubCtx(agents: Map<string, any>): any {
  return {
    get: (key: string) => (key === 'agents' ? { get: (id: string) => agents.get(id) } : key === 'sessions' ? { get: () => undefined } : undefined),
  }
}

test('supervisor: ask enqueues and notifies parent', async () => {
  const followups: string[] = []
  const parentAgent = { followup: (message: any) => { followups.push(message.content[0].text) } }
  const agents = new Map([['parent-1', parentAgent]])
  const channel = new SupervisorChannel({
    ctx: stubCtx(agents),
    parentOf: (childSessionId) => childSessionId === 'child-1' ? { parentSessionId: 'parent-1', agent: 'worker' } : undefined,
  })

  const result = await channel.ask('child-1', 'need_decision', 'May I change the schema?')
  assert.ok(result.id)
  assert.equal(followups.length, 1)
  assert.ok(followups[0]!.includes('worker'))
  assert.ok(followups[0]!.includes('May I change the schema?'))

  const pending = channel.pending('parent-1')
  assert.equal(pending.length, 1)
  assert.equal(pending[0]?.reason, 'need_decision')

  const reply = await channel.reply('parent-1', result.id, 'Yes, proceed.')
  assert.ok(reply.ok)
  assert.equal(channel.pending('parent-1').length, 0)
})

test('supervisor: reply to unknown request errors', async () => {
  const channel = new SupervisorChannel({ ctx: stubCtx(new Map()), parentOf: () => undefined })
  const result = await channel.reply('parent-1', 'nope', 'hi')
  assert.equal(result.ok, false)
  assert.ok(result.error)
})

test('supervisor: ask without parent context errors', async () => {
  const channel = new SupervisorChannel({ ctx: stubCtx(new Map()), parentOf: () => undefined })
  const result = await channel.ask('unknown-child', 'need_decision', 'hello')
  assert.ok(result.error?.includes('no supervisor context'))
})

test('supervisor: reply to offline child queues for resume', async () => {
  const channel = new SupervisorChannel({
    ctx: stubCtx(new Map()),
    parentOf: () => ({ parentSessionId: 'parent-1', agent: 'worker' }),
  })
  const asked = await channel.ask('child-1', 'need_decision', 'question')
  const reply = await channel.reply('parent-1', asked.id, 'answer')
  assert.ok(reply.ok)
  const queued = channel.takeQueuedReplies('parent-1')
  assert.equal(queued.length, 1)
  assert.ok(queued[0]!.includes('answer'))
})

test('supervisor: stats', async () => {
  const channel = new SupervisorChannel({
    ctx: stubCtx(new Map()),
    parentOf: () => ({ parentSessionId: 'parent-1', agent: 'worker' }),
  })
  await channel.ask('child-1', 'progress_update', 'working')
  const stats = channel.stats('parent-1')
  assert.equal(stats.pending, 1)
  assert.equal(stats.answered, 0)
})
