import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { parseAtTrigger, parseEveryInterval, ScheduleManager, type ScheduleDefinition } from '../src/schedules/manager.ts'
import type { SubagentsConfig } from '../src/types.ts'

function config(storeRoot: string): SubagentsConfig {
  return {
    toolDescriptionMode: 'compact', asyncByDefault: true, maxSubagentSpawnsPerRun: 64, maxSubagentDepth: 2,
    parallel: { maxTasks: 8, concurrency: 4 },
    missions: { enabled: true, retainTerminal: 200, globalIndex: true },
    scheduledRuns: { enabled: true, storeRoot, maxPending: 20 },
    intercomBridge: { mode: 'always', resultDelivery: false },
    watchdog: { enabled: false, main: {}, children: { overrides: {} }, scope: { enabled: false }, cadence: {}, autoFollow: { blockers: false, maxAttempts: 3, stalemateRepeats: 3 } },
    permissions: { rules: {} }, artifactDir: 'temp', forceTopLevelAsync: false, waitTool: { enabled: true },
  }
}

test('parseEveryInterval', () => {
  assert.equal(parseEveryInterval('30m').ms, 30 * 60_000)
  assert.equal(parseEveryInterval('6h').ms, 6 * 3_600_000)
  assert.equal(parseEveryInterval('2d').ms, 2 * 86_400_000)
  assert.equal(parseEveryInterval('1w').ms, 604_800_000)
  assert.ok(parseEveryInterval('6x').error)
  assert.ok(parseEveryInterval('abc').error)
})

test('parseAtTrigger', () => {
  const rel = parseAtTrigger('+10m')
  assert.ok(rel.plannedAt > Date.now())
  const iso = parseAtTrigger('2035-01-01T00:00:00Z')
  assert.ok(iso.plannedAt > Date.now())
  assert.ok(parseAtTrigger('not-a-date').error)
})

test('schedule create/list/pause/resume/delete lifecycle', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-schedules-'))
  try {
    const fired: Array<{ id: string; runId: string }> = []
    const manager = new ScheduleManager({
      config: config(root),
      projectRoot: '/tmp/project-s',
      onFire: async (definition, runId) => { fired.push({ id: definition.id, runId }) },
    })
    const created = await manager.create({ id: 'evening', name: 'Evening review', workflowScript: 'return 1', at: '+10m' })
    assert.ok(!created.error)
    const def = created.definition
    assert.equal(def.id, 'evening')
    assert.equal((await manager.list()).length, 1)

    await manager.pause(def.id)
    assert.ok((await manager.get(def.id))?.paused)
    await manager.resume(def.id)
    assert.ok(!(await manager.get(def.id))?.paused)

    const ran = await manager.runNow(def.id)
    assert.ok(ran.ok)
    assert.equal(fired.length, 1)

    const due = await manager.runDue()
    assert.ok(Array.isArray(due))

    await manager.delete(def.id)
    assert.equal((await manager.list()).length, 0)
    manager.stop()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('schedule every interval advances from anchor', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-schedules2-'))
  try {
    const manager = new ScheduleManager({
      config: config(root),
      projectRoot: '/tmp/project-s2',
      onFire: async () => {},
    })
    const created = await manager.create({ id: 'tick', name: 'tick', workflowScript: 'return 1', every: '6h' })
    assert.ok(!created.error)
    const before = created.definition.nextRunAt
    await manager.runNow('tick')
    const after = (await manager.get('tick'))?.nextRunAt
    assert.ok(after && before && after > before)
    manager.stop()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('schedule definition survives reload (durable)', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-schedules3-'))
  try {
    const make = () => new ScheduleManager({ config: config(root), projectRoot: '/tmp/project-s3', onFire: async () => {} })
    const manager = make()
    await manager.create({ id: 'durable', name: 'durable', workflowScript: 'return 1', every: '1d' })
    manager.stop()
    const reloaded = make()
    const defs = await reloaded.list()
    assert.equal(defs.length, 1)
    assert.equal(defs[0]?.id, 'durable')
    reloaded.stop()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('run-due returns started run ids', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-schedules4-'))
  try {
    const manager = new ScheduleManager({
      config: config(root),
      projectRoot: '/tmp/project-s4',
      onFire: async () => {},
    })
    const created = await manager.create({ id: 'due-soon', name: 'due', workflowScript: 'return 1', every: '1m' })
    assert.ok(!created.error)
    // 手动把触发时间拨到过去
    const def = created.definition
    def.nextRunAt = Date.now() - 1000
    await manager.save(def)
    const started = await manager.runDue()
    assert.equal(started.length, 1)
    manager.stop()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

export type { ScheduleDefinition }

test('fire: onFire marks the receipt terminal without being overwritten', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-schedules5-'))
  try {
    let managerRef: ScheduleManager | undefined
    const manager = new ScheduleManager({
      config: config(root),
      projectRoot: '/tmp/project-s5',
      onFire: async (definition, runId) => {
        // 模拟 services.ts：onFire 完成后终态化回执
        await managerRef!.markRunTerminal(definition.id, runId, 'completed')
      },
    })
    managerRef = manager
    const created = await manager.create({ id: 'receipt-order', name: 'receipt', workflowScript: 'return 1', every: '1h' })
    assert.ok(!created.error)
    // 拨快到过去并 runNow
    const def = created.definition
    def.nextRunAt = Date.now() - 1000
    await manager.save(def)
    const ran = await manager.runNow('receipt-order')
    assert.ok(ran.ok)
    const { readJsonFile } = await import('../src/util.ts')
    const receipts = await readJsonFile<Array<{ runId: string; status: string }>>(path.join(root, 'some', 'receipts.json')).catch(() => undefined)
    void receipts
    // 直接读 receipts 文件断言终态
    const { readFile } = await import('node:fs/promises')
    const files: string[] = []
    const walk = async (dir: string): Promise<void> => {
      const { readdir } = await import('node:fs/promises')
      let entries: string[]
      try { entries = await readdir(dir) } catch { return }
      for (const entry of entries) {
        const full = path.join(dir, entry)
        if (entry === 'receipts.json') files.push(full)
        else {
          const { stat } = await import('node:fs/promises')
          try { if ((await stat(full)).isDirectory()) await walk(full) } catch { /* ignore */ }
        }
      }
    }
    await walk(root)
    const receiptFile = files[0]
    assert.ok(receiptFile, 'receipts.json must exist')
    const parsed = JSON.parse(await readFile(receiptFile, 'utf8')) as Array<{ status: string }>
    assert.equal(parsed[0]?.status, 'completed', 'receipt must be terminal after onFire')
    manager.stop()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
