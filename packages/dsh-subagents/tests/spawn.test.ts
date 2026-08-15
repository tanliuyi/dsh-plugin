import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildPrompt, resolveAgentModelRoute, waitForSupervisorResolution } from '../src/runs/spawn.ts'
import type { SubagentsConfig } from '../src/types.ts'

const baseConfig: SubagentsConfig = {
  toolDescriptionMode: 'compact', asyncByDefault: true, maxSubagentSpawnsPerRun: 64, maxSubagentDepth: 2,
  parallel: { maxTasks: 8, concurrency: 4 },
  missions: { enabled: true, retainTerminal: 200, globalIndex: true },
  scheduledRuns: { enabled: true, maxPending: 20 },
  intercomBridge: { mode: 'always', resultDelivery: false },
  watchdog: { enabled: false, main: {}, children: { overrides: {} }, scope: { enabled: false }, cadence: {}, autoFollow: { blockers: false, maxAttempts: 3, stalemateRepeats: 3 } },
  permissions: { rules: {} }, artifactDir: 'temp', forceTopLevelAsync: false, waitTool: { enabled: true },
}

test('buildPrompt: includes bridge instructions and acceptance section', () => {
  const prompt = buildPrompt('Do the thing', {
    agent: { name: 'worker', systemPrompt: '', scope: 'builtin' } as never,
    context: 'fresh',
    parentSessionId: 'parent-1',
    config: baseConfig,
    acceptance: { level: 'checked', criteria: ['c'], evidence: ['changed-files'], verify: [] },
  })
  assert.ok(prompt.includes('Do the thing'))
  assert.ok(prompt.includes('contact_supervisor'))
  assert.ok(prompt.includes('acceptance-report'))
  assert.ok(prompt.includes('parent-1'))
})

test('buildPrompt: bridge off when intercomBridge.mode is off', () => {
  const config = { ...baseConfig, intercomBridge: { mode: 'off' as const, resultDelivery: false } }
  const prompt = buildPrompt('Do the thing', {
    agent: { name: 'worker', systemPrompt: '', scope: 'builtin' } as never,
    context: 'fresh',
    parentSessionId: 'parent-1',
    config,
  })
  assert.ok(!prompt.includes('contact_supervisor'))
})

test('resolveAgentModelRoute: agent model wins over default', () => {
  const config = { ...baseConfig, defaultModel: 'default-model' }
  const route = resolveAgentModelRoute({ model: 'provider/model-x' } as never, config, { provider: 'parent-p' })
  assert.deepEqual(route, { provider: 'provider', model: 'model-x' })
})

test('resolveAgentModelRoute: bare model uses parent provider', () => {
  const route = resolveAgentModelRoute({ model: 'bare-model' } as never, baseConfig, { provider: 'parent-p', model: 'parent-m' })
  assert.deepEqual(route, { provider: 'parent-p', model: 'bare-model' })
})

test('resolveAgentModelRoute: default model applies when agent has none', () => {
  const config = { ...baseConfig, defaultModel: 'def-model' }
  const route = resolveAgentModelRoute({} as never, config, {})
  assert.deepEqual(route, { provider: undefined, model: 'def-model' })
})

/** 事件桩：ctx.on 收集监听器，测试手动派发 agent/status 与 agent/disposed。 */
function eventStub(): { emit: (event: string, payload: unknown) => void; ctx: { on: (event: string, listener: (payload: never) => void) => () => void } } {
  const listeners = new Map<string, Array<(payload: never) => void>>()
  const ctx = {
    on: (event: string, listener: (payload: never) => void) => {
      const list = listeners.get(event) ?? []
      list.push(listener)
      listeners.set(event, list)
      return () => {
        const next = (listeners.get(event) ?? []).filter((l) => l !== listener)
        if (next.length) listeners.set(event, next)
        else listeners.delete(event)
      }
    },
  }
  return {
    emit: (event: string, payload: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(payload as never)
    },
    ctx,
  }
}

test('waitForSupervisorResolution: stays pending while requests remain, resolves after the reply turn ends', async () => {
  const { emit, ctx } = eventStub()
  let pending: Array<{ id: string; childSessionId: string }> = [{ id: 'req-1', childSessionId: 'child-1' }]
  const childAgent = { id: 'child-1' } as never
  const promise = waitForSupervisorResolution({ ctx, supervisor: { pending: () => pending } } as never, childAgent, 'parent-1', 'child-1', 5000)

  // 回合结束但仍有未答复请求 → 不得终结
  emit('agent/status', { agent: childAgent, status: 'idle' })
  await Promise.resolve()
  let settled = false
  void promise.then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'must keep waiting while a supervisor request is pending')

  // 父回复被消费（pending 清空）后，child 的新回合结束 → 最终完成
  pending = []
  emit('agent/status', { agent: childAgent, status: 'running' })
  emit('agent/status', { agent: childAgent, status: 'idle' })
  assert.equal(await promise, 'resolved')
})

test('waitForSupervisorResolution: ignores requests from other children', async () => {
  const { emit, ctx } = eventStub()
  // 只有另一个 child 的 pending：本 child 无未答复请求 → 回合结束即完成
  const pending = [{ id: 'req-other', childSessionId: 'child-other' }]
  const childAgent = { id: 'child-1' } as never
  const promise = waitForSupervisorResolution({ ctx, supervisor: { pending: () => pending } } as never, childAgent, 'parent-1', 'child-1', 5000)
  emit('agent/status', { agent: childAgent, status: 'idle' })
  assert.equal(await promise, 'resolved')
})

test('waitForSupervisorResolution: times out when the parent never replies', async () => {
  const { ctx } = eventStub()
  const childAgent = { id: 'child-2' } as never
  const resolution = await waitForSupervisorResolution(
    { ctx, supervisor: { pending: () => [{ id: 'req-1', childSessionId: 'child-2' }] } } as never,
    childAgent,
    'parent-1',
    'child-2',
    20,
  )
  assert.equal(resolution, 'timeout')
})

test('waitForSupervisorResolution: settles disposed when the child is destroyed', async () => {
  const { emit, ctx } = eventStub()
  const childAgent = { id: 'child-3' } as never
  const promise = waitForSupervisorResolution(
    { ctx, supervisor: { pending: () => [{ id: 'req-1', childSessionId: 'child-3' }] } } as never,
    childAgent,
    'parent-1',
    'child-3',
    5000,
  )
  emit('agent/disposed', { agent: childAgent })
  assert.equal(await promise, 'disposed')
})
