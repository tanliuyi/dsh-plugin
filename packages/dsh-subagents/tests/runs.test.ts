import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { RunStore } from '../src/runs/store.ts'
import { formatStatus, formatResultSummary } from '../src/runs/status.ts'
import { interruptRun, steerRun, listChildren } from '../src/runs/control.ts'
import { dispatchAction, SessionState, type SubagentsDeps } from '../src/runs/execution.ts'
import { AgentRegistry } from '../src/agents/registry.ts'
import type { SubagentsConfig } from '../src/types.ts'
import { resolveSubagentLaunchContract } from '../src/preflight.ts'
import { parseModelSpec, fuzzyMatchModel } from '../src/llm.ts'

function baseConfig(overrides?: Record<string, unknown>): SubagentsConfig {
  return {
    toolDescriptionMode: 'compact',
    asyncByDefault: true,
    maxSubagentSpawnsPerRun: 64,
    maxSubagentDepth: 2,
    parallel: { maxTasks: 8, concurrency: 4 },
    missions: { enabled: true, retainTerminal: 200, globalIndex: true },
    scheduledRuns: { enabled: true, maxPending: 20 },
    intercomBridge: { mode: 'always', resultDelivery: false },
    watchdog: { enabled: false, main: {}, children: { overrides: {} }, scope: { enabled: false }, cadence: {}, autoFollow: { blockers: false, maxAttempts: 3, stalemateRepeats: 3 } },
    permissions: { rules: {} },
    artifactDir: 'temp',
    forceTopLevelAsync: false,
    waitTool: { enabled: true },
    ...overrides,
  } as SubagentsConfig
}

test('RunStore: create/addChild/finishRun lifecycle', async () => {
  const store = new RunStore({ sessionId: 's1', cwd: '/tmp' })
  const run = store.createRun({ mode: 'single', agent: 'scout' })
  assert.equal(run.state, 'running')
  store.addChild(run.id, { index: 0, agent: 'scout', task: 'recon', status: 'running', startedAt: Date.now() })
  store.finishChild(run.id, 0, { status: 'completed', output: 'found stuff', endedAt: Date.now() })
  const finished = store.finishRun(run.id, 'completed')
  assert.equal(finished?.state, 'completed')
  assert.equal(finished?.results.length, 1)
  assert.equal(finished?.results[0]?.exitCode, 0)
  assert.equal(store.activeRuns().length, 0)
  assert.equal(store.retainedChildren('s1').length, 1)
})

test('RunStore: find by prefix', () => {
  const store = new RunStore({ sessionId: 's1', cwd: '/tmp' })
  const run = store.createRun({ mode: 'single', agent: 'scout' })
  assert.equal(store.find(run.id.slice(0, 6))?.id, run.id)
  assert.equal(store.find('zzz'), undefined)
})

test('RunStore: childByRunId resolves after updateChild assigns runId', () => {
  const store = new RunStore({ sessionId: 's1', cwd: '/tmp' })
  const run = store.createRun({ mode: 'single', agent: 'delegate' })
  store.addChild(run.id, { index: 0, agent: 'delegate', task: 'ask', status: 'queued', startedAt: Date.now() })
  // 启动解析后写入 runId（此前 addChild 时 runId 尚不存在）
  store.updateChild(run.id, 0, { runId: 'child-session-1', status: 'running' })
  const child = store.childByRunId('child-session-1')
  assert.ok(child, 'childByRunId must find the child after runId registration')
  assert.equal(child?.agent, 'delegate')
})

test('formatStatus: empty guidance', () => {
  const store = new RunStore({ sessionId: 's1', cwd: '/tmp' })
  const { text } = formatStatus(store)
  assert.ok(text.includes('No subagent runs'))
  assert.ok(text.includes('scout'))
})

test('formatStatus: run blocks and fleet view', () => {
  const store = new RunStore({ sessionId: 's1', cwd: '/tmp' })
  const run = store.createRun({ mode: 'single', agent: 'worker', goal: 'Implement X' })
  store.addChild(run.id, { index: 0, agent: 'worker', task: 'impl', status: 'running', startedAt: Date.now() })
  const { text } = formatStatus(store, 'fleet')
  assert.ok(text.includes('worker'))
  assert.ok(text.includes('running'))
  const byId = formatStatus(store, undefined, run.id)
  assert.ok(byId.text.includes(run.id))
})

test('formatResultSummary', () => {
  const store = new RunStore({ sessionId: 's1', cwd: '/tmp' })
  const run = store.createRun({ mode: 'single', agent: 'reviewer' })
  store.addChild(run.id, { index: 0, agent: 'reviewer', task: 'r', status: 'completed', startedAt: Date.now() })
  store.finishRun(run.id, 'completed')
  const text = formatResultSummary(store.get(run.id)!)
  assert.ok(text.includes('✓ reviewer'))
})

test('interruptRun targets active children', () => {
  const store = new RunStore({ sessionId: 's1', cwd: '/tmp' })
  let cancelled = 0
  const run = store.createRun({ mode: 'single', agent: 'worker' })
  store.addChild(run.id, { index: 0, agent: 'worker', task: 'w', status: 'running', startedAt: Date.now(), localAgent: { cancel: () => { cancelled++ } } as never })
  const result = interruptRun(store, run.id)
  assert.ok(result.ok)
  assert.equal(cancelled, 1)
})

test('steerRun: follow_up queues brief for completed child', () => {
  const store = new RunStore({ sessionId: 's1', cwd: '/tmp' })
  const run = store.createRun({ mode: 'single', agent: 'worker' })
  store.addChild(run.id, { index: 0, agent: 'worker', task: 'w', status: 'completed', startedAt: Date.now() })
  const result = steerRun(store, run.id, 'check this', { mode: 'follow_up' })
  assert.ok(result.ok)
  assert.equal(result.deliveryStatus, 'queued')
  assert.equal(store.get(run.id)?.children[0]?.followUpBrief, 'check this')
})

test('listChildren formatting', () => {
  const store = new RunStore({ sessionId: 's1', cwd: '/tmp' })
  const run = store.createRun({ mode: 'single', agent: 'worker' })
  store.addChild(run.id, { index: 0, agent: 'worker', task: 'w', status: 'completed', startedAt: Date.now(), runId: 'child-run-1' })
  store.finishRun(run.id, 'completed')
  const { text } = listChildren(store, 's1')
  assert.ok(text.includes('child-run-1'))
  assert.ok(text.includes('resumable'))
})

test('preflight: missing agent and contract resolution', async () => {
  const missing = await resolveSubagentLaunchContract({ agent: 'no-such-agent', cwd: '/tmp' })
  assert.equal(missing.ok, false)
  assert.ok(missing.message?.includes('missing_agent'))

  const resolved = await resolveSubagentLaunchContract({ agent: 'scout', task: 'recon', cwd: '/tmp', context: 'fresh' })
  assert.equal(resolved.ok, true)
  assert.equal(resolved.contract?.agent, 'scout')
  assert.equal(resolved.contract?.provider, 'spawn')
  assert.ok(resolved.contract?.tools.effectiveAllowlist?.includes('read'))
})

test('preflight: empty agent rejected', async () => {
  const result = await resolveSubagentLaunchContract({ agent: '  ', cwd: '/tmp' })
  assert.equal(result.ok, false)
})

test('parseModelSpec: provider/model/effort splits', () => {
  assert.deepEqual(parseModelSpec('anthropic/claude-sonnet-4:high'), { provider: 'anthropic', model: 'claude-sonnet-4', effort: 'high' })
  assert.deepEqual(parseModelSpec('deepseek-v4-pro'), { model: 'deepseek-v4-pro' })
  assert.deepEqual(parseModelSpec('a/b/c'), { provider: 'a', model: 'b/c' })
  assert.deepEqual(parseModelSpec(undefined), {})
})

test('fuzzyMatchModel: separators and case', () => {
  assert.ok(fuzzyMatchModel('claude-haiku-4-5', 'claude-haiku-4.5'))
  assert.ok(fuzzyMatchModel('Claude-Sonnet-4', 'claude-sonnet-4'))
  assert.ok(fuzzyMatchModel('openai/gpt-5-mini', 'gpt-5-mini'))
  assert.ok(!fuzzyMatchModel('gpt-5-mini', 'gpt-4'))
})

test('dispatchAction resume: legacy resume field accepted, id still works', async () => {
  const state = new SessionState()
  const exec = { parent: { session: { id: 's1' } }, signal: new AbortController().signal, cwd: '/tmp' } as never
  const deps = {
    ctx: {},
    config: baseConfig(),
    registry: new AgentRegistry(baseConfig(), '/tmp'),
    supervisor: {},
    services: { for: () => ({ missions: { finalizeIfIdle: async () => undefined } }) },
    home: '/tmp',
  } as unknown as SubagentsDeps

  // 只有旧字段 resume：不再报 "resume requires id"，参数被接受（进入 launchResume 后未找到 retained）
  const legacy = await dispatchAction(deps, state, exec, { action: 'resume', resume: 'no-such-retained' })
  assert.ok(legacy.text.includes('retained child no-such-retained not found'), `legacy field must reach launchResume: ${legacy.text}`)

  // id 字段等价
  const byId = await dispatchAction(deps, state, exec, { action: 'resume', id: 'no-such-retained' })
  assert.ok(byId.text.includes('retained child no-such-retained not found'))

  // 两者皆无：明确报错
  const missing = await dispatchAction(deps, state, exec, { action: 'resume' })
  assert.ok(missing.text.includes('resume requires id'))
})

test('dispatchAction stop: finalizes the auto mission of a stuck run (no child callback)', async () => {
  const state = new SessionState()
  const store = state.store('s1', '/tmp')
  // 模拟悬挂 workflow：有 missionId、无 active children（child 早已结束/从未启动）
  const run = store.createRun({ mode: 'workflow', agent: 'workflow', missionId: 'mission-stuck', goal: 'x' })
  assert.equal(run.active, true)

  const missionCalls: string[] = []
  const deps = {
    ctx: {},
    config: baseConfig(),
    registry: new AgentRegistry(baseConfig(), '/tmp'),
    supervisor: {},
    services: {
      for: () => ({
        missions: {
          updateRunStatus: async (_id: string, _runId: string, status: string) => { missionCalls.push(`status:${status}`) },
          finalizeIfIdle: async (_id: string, status: string) => { missionCalls.push(`finalize:${status}`) },
        },
      }),
    },
    home: '/tmp',
  } as unknown as SubagentsDeps
  const exec = { parent: { session: { id: 's1' } }, signal: new AbortController().signal, cwd: '/tmp' } as never

  const result = await dispatchAction(deps, state, exec, { action: 'stop', id: run.id })
  assert.ok(result.text.includes('stopped'))
  assert.equal(store.find(run.id)?.state, 'stopped')
  // 悬挂 run 无 child 回调可依赖：stop 必须自行终结 mission
  assert.deepEqual(missionCalls, ['status:stopped', 'finalize:failed'], 'stop must update the mission and finalize the auto mission')
})

test('dispatchAction stop: mission untouched when run has no missionId', async () => {
  const state = new SessionState()
  const store = state.store('s1', '/tmp')
  const run = store.createRun({ mode: 'single', agent: 'delegate' })
  const calls: string[] = []
  const deps = {
    ctx: {},
    config: baseConfig(),
    registry: new AgentRegistry(baseConfig(), '/tmp'),
    supervisor: {},
    services: {
      for: () => ({
        missions: {
          updateRunStatus: async () => { calls.push('status') },
          finalizeIfIdle: async () => { calls.push('finalize') },
        },
      }),
    },
    home: '/tmp',
  } as unknown as SubagentsDeps
  const exec = { parent: { session: { id: 's1' } }, signal: new AbortController().signal, cwd: '/tmp' } as never

  await dispatchAction(deps, state, exec, { action: 'stop', id: run.id })
  assert.deepEqual(calls, [], 'no missionId means no mission bookkeeping')
})
