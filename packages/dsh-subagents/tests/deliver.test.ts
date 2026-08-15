import { test } from 'node:test'
import assert from 'node:assert/strict'

import { deliverNotice } from '../src/intercom/deliver.ts'

function stubAgent(status: 'idle' | 'running'): { agent: any; calls: string[] } {
  const calls: string[] = []
  const agent = {
    status,
    inject: (message: any) => { calls.push(`inject:${message.content[0].text}`) },
    followup: (message: any) => { calls.push(`followup:${message.content[0].text}`) },
  }
  return { agent, calls }
}

test('deliverNotice: running agent gets inject (mid-turn context)', () => {
  const { agent, calls } = stubAgent('running')
  deliverNotice(agent, 'hello parent')
  assert.equal(calls.length, 1)
  assert.ok(calls[0]!.startsWith('inject:'))
  assert.ok(calls[0]!.includes('hello parent'))
})

test('deliverNotice: idle agent gets followup (wakes a new turn)', () => {
  const { agent, calls } = stubAgent('idle')
  deliverNotice(agent, 'hello parent')
  assert.equal(calls.length, 1)
  assert.ok(calls[0]!.startsWith('followup:'))
})

test('deliverNotice: message carries the plugin source', () => {
  const { agent, calls } = stubAgent('running')
  deliverNotice(agent, 'notice')
  assert.ok(calls[0]!.includes('notice'))
})
