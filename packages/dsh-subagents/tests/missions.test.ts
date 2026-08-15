import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { MissionStore } from '../src/missions/store.ts'
import { runMissionAction, validateMissionInput } from '../src/missions/actions.ts'
import { nextReadyAction } from '../src/missions/goal-driver.ts'
import type { SubagentsConfig } from '../src/types.ts'

function configWithDir(dir: string): SubagentsConfig {
  return {
    toolDescriptionMode: 'compact', asyncByDefault: true, maxSubagentSpawnsPerRun: 64, maxSubagentDepth: 2,
    parallel: { maxTasks: 8, concurrency: 4 },
    missions: { enabled: true, directory: dir, retainTerminal: 2, globalIndex: true },
    scheduledRuns: { enabled: true, maxPending: 20 },
    intercomBridge: { mode: 'always', resultDelivery: false },
    watchdog: { enabled: false, main: {}, children: { overrides: {} }, scope: { enabled: false }, cadence: {}, autoFollow: { blockers: false, maxAttempts: 3, stalemateRepeats: 3 } },
    permissions: { rules: {} }, artifactDir: 'temp', forceTopLevelAsync: false, waitTool: { enabled: true },
  }
}

function makeStore(dir: string, home: string): MissionStore {
  return new MissionStore(configWithDir(dir), '/tmp/project-a', home)
}

test('mission create/list/show/close lifecycle', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-missions-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-mhome-'))
  try {
    const store = makeStore(dir, home)
    const created = await store.create({ title: 'Ship auth refresh', objective: 'Implement token refresh' })
    assert.equal(created.status, 'planned')
    assert.ok(created.id)

    const listed = await store.list('project')
    assert.equal(listed.length, 1)

    await store.attachRun(created.id, { runId: 'r1', agent: 'worker', task: 'impl', status: 'running', updatedAt: Date.now() })
    const after = await store.get(created.id)
    assert.equal(after?.status, 'active')
    assert.equal(after?.runs.length, 1)

    await store.close(created.id, 'completed', 'done')
    const closed = await store.get(created.id)
    assert.equal(closed?.status, 'completed')
    assert.ok(closed?.endedAt)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('finalizeIfIdle: auto mission closes only when idle', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-missions3-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-mhome3-'))
  try {
    const store = makeStore(dir, home)

    // 显式 mission（非 auto）：永不自动终结，生命周期归用户
    const manual = await store.create({ title: 'manual mission' })
    await store.attachRun(manual.id, { runId: 'r1', agent: 'worker', task: 't', status: 'completed', updatedAt: Date.now() })
    await store.finalizeIfIdle(manual.id, 'completed')
    assert.equal((await store.get(manual.id))?.status, 'active')

    // auto mission 仍有进行中的 run：保持 active
    const auto = await store.create({ title: 'auto mission', auto: true })
    assert.equal(auto.auto, true)
    await store.attachRun(auto.id, { runId: 'r2', agent: 'worker', task: 't', status: 'running', updatedAt: Date.now() })
    await store.finalizeIfIdle(auto.id, 'completed')
    assert.equal((await store.get(auto.id))?.status, 'active')

    // auto mission 全部 run 终态：置为 terminal
    await store.updateRunStatus(auto.id, 'r2', 'completed')
    await store.finalizeIfIdle(auto.id, 'completed')
    const closed = await store.get(auto.id)
    assert.equal(closed?.status, 'completed')
    assert.ok(closed?.endedAt)

    // 已终态后不再改写
    await store.finalizeIfIdle(auto.id, 'failed')
    assert.equal((await store.get(auto.id))?.status, 'completed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('mission actions: create validation and decision gating', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-missions2-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-mhome2-'))
  try {
    const store = makeStore(dir, home)
    // 必须恰好一个 title 或 summary
    assert.ok(validateMissionInput({}).error)
    assert.ok(validateMissionInput({ title: 'a', summary: 'b' }).error)
    // goal 需要 budget
    assert.ok(validateMissionInput({ title: 'a', goal: true }).error)
    assert.ok(!validateMissionInput({ title: 'a', goal: true, budget: { tokens: 100 } }).error)

    const created = await runMissionAction(store, { action: 'mission.create', mission: { title: 'Gated mission' } })
    assert.ok(created.missionId)
    // 先挂一个运行 → active（planned 保持原状态，与 pi 语义一致）
    await runMissionAction(store, {
      action: 'mission.attach-run',
      missionId: created.missionId,
      runId: 'run-1',
      config: { agent: 'worker', task: 'work' },
    })

    // update 添加 decision → needs_decision
    const updated = await runMissionAction(store, {
      action: 'mission.update',
      missionId: created.missionId,
      config: { decisions: [{ id: 'd1', question: 'Proceed?' }] },
    })
    assert.equal(updated.status, 'needs_decision')

    // 解析 decision → active
    const resolved = await runMissionAction(store, {
      action: 'mission.resolve-decision',
      missionId: created.missionId,
      decisionId: 'd1',
      summary: 'yes',
    })
    assert.equal(resolved.status, 'active')

    // close
    const closed = await runMissionAction(store, { action: 'mission.close', missionId: created.missionId })
    assert.equal(closed.status, 'completed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('mission receipts and state file', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-missions3-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-mhome3-'))
  try {
    const store = makeStore(dir, home)
    const record = await store.create({ title: 'Release' })
    await runMissionAction(store, {
      action: 'mission.update',
      missionId: record.id,
      config: { receipts: [{ kind: 'pr', status: 'open', title: 'PR #1', url: 'https://example.com/pr/1' }] },
    })
    const after = await store.get(record.id)
    assert.equal(after?.receipts.length, 1)
    assert.equal(after?.receipts[0]?.kind, 'pr')
    const text = (await runMissionAction(store, { action: 'mission.show', missionId: record.id })).text
    assert.ok(text.includes('PR #1'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('prune removes oldest terminal records beyond retainTerminal', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-missions4-'))
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-mhome4-'))
  try {
    const store = makeStore(dir, home)
    const first = await store.create({ title: 'one' })
    const second = await store.create({ title: 'two' })
    await store.create({ title: 'three' })
    await store.close(first.id, 'completed')
    const pruned = await store.prune()
    assert.equal(pruned, 0) // 只有 1 个终态，未超 retainTerminal=2
    await store.close(second.id, 'completed')
    const records = await store.list('project')
    const third = records.find((r) => r.status !== 'completed')
    if (third) await store.close(third.id, 'completed')
    const pruned2 = await store.prune()
    assert.equal(pruned2, 1) // 3 个终态，保留 2，删最旧
    const remaining = await store.list('project')
    assert.equal(remaining.length, 2)
    assert.ok(!remaining.some((r) => r.id === first.id))
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(home, { recursive: true, force: true })
  }
})

test('nextReadyAction prefers explicit action and open decisions', () => {
  assert.equal(nextReadyAction({ nextReadyAction: 'implement X' }), 'implement X')
  assert.ok(nextReadyAction({ decisions: [{ resolution: undefined }] } as never).includes('decision'))
  assert.ok(nextReadyAction({}).includes('continue'))
})
