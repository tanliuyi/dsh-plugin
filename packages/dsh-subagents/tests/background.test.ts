import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SessionState, runInBackground, backgroundCompletionText } from '../src/runs/execution.ts'
import { RunStore } from '../src/runs/store.ts'
import type { SubagentsConfig } from '../src/types.ts'

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
    maxActiveAsyncRunsPerSession: 4,
    ...overrides,
  } as SubagentsConfig
}

interface FakeJob {
  cancel: (reason?: string) => void
  done: Promise<unknown>
}

/** 极简 jobs 服务：start 同步取出任务，wait 永不报告（避免触发通知投递）。 */
function makeFakeJobs(): { jobs: object; started: FakeJob[] } {
  const started: FakeJob[] = []
  const jobs = {
    start(entry: { kind: string; label: string; owner: unknown; run: () => FakeJob }): string {
      started.push(entry.run())
      return `job-${started.length}`
    },
    wait(): Promise<{ status: string }> {
      return Promise.resolve({ status: 'running' })
    },
  }
  return { jobs, started }
}

function fakeDeps(jobs: object): never {
  return {
    ctx: { get: (name: string) => (name === 'jobs' ? jobs : undefined) },
    config: baseConfig(),
  } as never
}

function fakeExec(aborted = false): never {
  const controller = new AbortController()
  if (aborted) controller.abort('caller turn ended')
  return {
    parent: { session: { id: 's1' }, status: 'idle', inject: () => {}, followup: () => {} },
    signal: controller.signal,
    cwd: '/tmp',
  } as never
}

test('runInBackground: work receives an independent signal even when the caller signal is already aborted', async () => {
  // 回归：工具调用返回后 exec.signal 会被中止；后台 run 必须继续执行（独立信号）。
  const state = new SessionState()
  const fake = makeFakeJobs()
  let workSignal: AbortSignal | undefined
  let workRan = false
  const { jobId } = await runInBackground(fakeDeps(fake.jobs), fakeExec(true), state, 'test bg', (signal) => {
    workSignal = signal
    workRan = true
    return Promise.resolve()
  })
  assert.ok(jobId, 'background job must start')
  assert.ok(workRan, 'work must run')
  assert.ok(workSignal, 'work must receive a signal')
  assert.equal(workSignal!.aborted, false, 'work must NOT inherit the aborted caller signal')
})

test('runInBackground: job cancel aborts the work signal', async () => {
  const state = new SessionState()
  const fake = makeFakeJobs()
  let sawAbort = false
  await runInBackground(fakeDeps(fake.jobs), fakeExec(), state, 'test bg', (signal) => {
    signal.addEventListener('abort', () => { sawAbort = true })
    return new Promise((resolve) => setTimeout(resolve, 50))
  })
  assert.equal(fake.started.length, 1)
  fake.started[0]!.cancel('killed by test')
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.ok(sawAbort, 'job cancel must abort the work signal')
  await fake.started[0]!.done
})

test('backgroundCompletionText: falls back to the job snapshot when the run record is missing', () => {
  // 兜底：store 无对应 run（如会话清理后）时，通知必须仍以 job 快照状态呈现，
  // 不能产生 undefined 状态文本。
  const state = new SessionState()
  const text = backgroundCompletionText(state, 's1', 'job-ghost', { status: 'failed', detail: 'ghost' })
  assert.ok(text, 'notice text must be produced from the job snapshot alone')
  assert.ok(text!.includes('job-ghost'), `notice must name the job id, got: ${text}`)
  assert.ok(text!.includes('failed'), `notice must carry the job snapshot status, got: ${text}`)
})

test('backgroundCompletionText: reports the run record state instead of the job snapshot', () => {
  // 回归：后台 launch/execute 捕获错误后 run 为 failed，而 job 快照仍为 completed；
  // 通知必须以 run 记录为准，不能误报 completed。
  const state = new SessionState()
  const store = new RunStore({ sessionId: 's1', cwd: '/tmp' })
  state.stores.set('s1', store)
  const run = store.createRun({ mode: 'single', agent: 'delegate', goal: 'bg' })
  run.jobId = 'job-1' // 真实流程由 runInBackground 返回后回填
  store.addChild(run.id, { index: 0, agent: 'delegate', task: 't', status: 'running', startedAt: Date.now() })
  store.finishRun(run.id, 'failed')
  const text = backgroundCompletionText(state, 's1', 'job-1', { status: 'completed' })
  assert.ok(text, 'notice text must be produced')
  assert.ok(text!.includes('failed'), `notice must report the run state (failed), got: ${text}`)
  assert.ok(!text!.includes('(delegate) completed'), `notice must not misreport completed, got: ${text}`)
})
