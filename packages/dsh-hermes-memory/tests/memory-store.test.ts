import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { MemoryStore } from '../src/store/memory-store.ts'
import { ENTRY_DELIMITER } from '../src/constants.ts'
import type { MemoryConfig } from '../src/types.ts'

/** 在临时目录构造配置。 */
async function makeConfig(overrides: Partial<MemoryConfig> = {}): Promise<{ config: MemoryConfig; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-mem-'))
  const config: MemoryConfig = {
    memoryMode: 'policy-only',
    memoryCharLimit: 5000,
    userCharLimit: 5000,
    projectCharLimit: 5000,
    nudgeInterval: 10,
    reviewEnabled: true,
    flushOnCompact: true,
    flushOnShutdown: true,
    flushMinTurns: 6,
    autoConsolidate: true,
    correctionDetection: true,
    failureInjectionEnabled: true,
    failureInjectionMaxAgeDays: 7,
    failureInjectionMaxEntries: 5,
    nudgeToolCalls: 15,
    consolidationTimeoutMs: 180000,
    autoConsolidationWarnOnFailure: true,
    standingInstructionsEnabled: true,
    memoryDir: dir,
    ...overrides,
  }
  return { config, dir }
}

test('add writes entries and survives reload', async () => {
  const { config, dir } = await makeConfig()
  const store = new MemoryStore(config)
  await store.loadFromDisk()

  const result = await store.add('memory', 'user prefers pnpm over npm')
  assert.equal(result.success, true)
  assert.equal(result.entry_count, 1)

  const store2 = new MemoryStore(config)
  await store2.loadFromDisk()
  assert.deepEqual(store2.getMemoryEntries(), ['user prefers pnpm over npm'])
  await fs.rm(dir, { recursive: true, force: true })
})

test('duplicate add is rejected without error', async () => {
  const { config, dir } = await makeConfig()
  const store = new MemoryStore(config)
  await store.loadFromDisk()

  await store.add('memory', 'use pnpm')
  const result = await store.add('memory', 'use pnpm')
  assert.equal(result.success, true)
  assert.match(result.message!, /already exists/)
  assert.equal(store.getMemoryEntries().length, 1)
  await fs.rm(dir, { recursive: true, force: true })
})

test('empty content is rejected', async () => {
  const { config, dir } = await makeConfig()
  const store = new MemoryStore(config)
  await store.loadFromDisk()
  const result = await store.add('memory', '   ')
  assert.equal(result.success, false)
  assert.match(result.error!, /empty/)
  await fs.rm(dir, { recursive: true, force: true })
})

test('secret content is blocked by the scanner', async () => {
  const { config, dir } = await makeConfig()
  const store = new MemoryStore(config)
  await store.loadFromDisk()
  const result = await store.add('memory', 'my key is sk-abcdefghijklmnopqrstuvwxyz123456')
  assert.equal(result.success, false)
  assert.match(result.error!, /credential or secret/)
  assert.equal(store.getMemoryEntries().length, 0)
  await fs.rm(dir, { recursive: true, force: true })
})

test('replace swaps the whole entry and preserves created date', async () => {
  const { config, dir } = await makeConfig()
  const store = new MemoryStore(config)
  await store.loadFromDisk()

  await store.add('memory', 'user prefers npm')
  const result = await store.replace('memory', 'prefers npm', 'user prefers pnpm')
  assert.equal(result.success, true)
  assert.deepEqual(store.getMemoryEntries(), ['user prefers pnpm'])

  // created date preserved (from original entry metadata)
  const raw = await fs.readFile(path.join(dir, 'MEMORY.md'), 'utf-8')
  assert.match(raw, /<!-- created=/)
  await fs.rm(dir, { recursive: true, force: true })
})

test('replace refuses partial multi-line replacement', async () => {
  const { config, dir } = await makeConfig()
  const store = new MemoryStore(config)
  await store.loadFromDisk()

  await store.add('memory', 'line one\nline two')
  const result = await store.replace('memory', 'line one', 'line one changed')
  assert.equal(result.success, false)
  assert.match(result.error!, /Refusing replace/)
  await fs.rm(dir, { recursive: true, force: true })
})

test('remove deletes by substring', async () => {
  const { config, dir } = await makeConfig()
  const store = new MemoryStore(config)
  await store.loadFromDisk()

  await store.add('memory', 'alpha fact')
  await store.add('memory', 'beta fact')
  const result = await store.remove('memory', 'alpha')
  assert.equal(result.success, true)
  assert.deepEqual(store.getMemoryEntries(), ['beta fact'])
  await fs.rm(dir, { recursive: true, force: true })
})

test('char limit rejects overflow and fifo-evict rotates', async () => {
  const { config, dir } = await makeConfig({ memoryCharLimit: 100, memoryOverflowStrategy: 'reject' })
  const store = new MemoryStore(config)
  await store.loadFromDisk()

  await store.add('memory', 'first entry content here')
  const rejected = await store.add('memory', 'a much longer second entry that will not fit')
  assert.equal(rejected.success, false)
  assert.match(rejected.error!, /Memory at .* chars/)

  const evictConfig = { ...config, memoryOverflowStrategy: 'fifo-evict' as const }
  const evictStore = new MemoryStore(evictConfig)
  await evictStore.loadFromDisk()
  const evicted = await evictStore.add('memory', 'second entry')
  assert.equal(evicted.success, true)
  assert.equal(evicted.evicted_count, 1)
  assert.deepEqual(evictStore.getMemoryEntries(), ['second entry'])
  await fs.rm(dir, { recursive: true, force: true })
})

test('failure entries carry category and get failure metadata', async () => {
  const { config, dir } = await makeConfig()
  const store = new MemoryStore(config)
  await store.loadFromDisk()

  const result = await store.addFailure('used localStorage for tokens', {
    category: 'failure',
    failureReason: 'XSS vulnerability',
  })
  assert.equal(result.success, true)
  const entries = store.getAllFailureEntries()
  assert.equal(entries.length, 1)
  assert.match(entries[0]!, /\[failure\] used localStorage for tokens/)
  assert.match(entries[0]!, /Failed: XSS vulnerability/)
  await fs.rm(dir, { recursive: true, force: true })
})

test('applyMutationPlan applies operations atomically with requireShrink', async () => {
  const { config, dir } = await makeConfig()
  const store = new MemoryStore(config)
  await store.loadFromDisk()

  await store.add('memory', 'alpha')
  await store.add('memory', 'beta')
  await store.add('memory', 'gamma')

  const result = await store.applyMutationPlan('memory', [
    { action: 'remove', oldText: 'alpha' },
    { action: 'remove', oldText: 'beta' },
    { action: 'add', content: 'delta' },
  ], { requireShrink: true })
  assert.equal(result.success, true)
  assert.deepEqual(store.getMemoryEntries(), ['gamma', 'delta'])

  const noShrink = await store.applyMutationPlan('memory', [
    { action: 'add', content: 'epsilon' },
  ], { requireShrink: true })
  assert.equal(noShrink.success, false)
  assert.match(noShrink.error!, /did not shrink/)
  await fs.rm(dir, { recursive: true, force: true })
})

test('external edits are picked up before mutation (fingerprint sync)', async () => {
  const { config, dir } = await makeConfig()
  const store = new MemoryStore(config)
  await store.loadFromDisk()
  await store.add('memory', 'original')

  // 外部编辑：手工追加一条
  const filePath = path.join(dir, 'MEMORY.md')
  const raw = await fs.readFile(filePath, 'utf-8')
  await fs.writeFile(filePath, raw + ENTRY_DELIMITER + 'external note', 'utf-8')

  const result = await store.add('memory', 'another entry')
  assert.equal(result.success, true)
  const entries = store.getMemoryEntries()
  assert.ok(entries.includes('external note'))
  assert.ok(entries.includes('another entry'))
  await fs.rm(dir, { recursive: true, force: true })
})

test('project metadata is encoded and decoded (base64url)', async () => {
  const { config, dir } = await makeConfig()
  const store = new MemoryStore(config)
  await store.loadFromDisk()

  await store.addFailure('ci needs frozen lockfile', { category: 'tool-quirk', project: 'my project' })
  const entries = store.getRawEntriesForSync('failure')
  assert.equal(entries.length, 1)
  assert.match(entries[0]!, /project64=/)
  await fs.rm(dir, { recursive: true, force: true })
})
