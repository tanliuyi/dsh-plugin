import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'

import { ExtendedMemoryStore } from '../src/store/extended-store.ts'
import { ENTRY_DELIMITER } from '../src/constants.ts'

function encodeEntry(text: string, created: string, last: string, project?: string): string {
  const projectMetadata = project
    ? `, project64=${Buffer.from(project, 'utf-8').toString('base64url')}`
    : ''
  return `${text} <!-- created=${created}, last=${last}${projectMetadata} -->`
}

async function makeStore(): Promise<{ store: ExtendedMemoryStore; dir: string }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hm-ext-'))
  const store = new ExtendedMemoryStore(dir)
  await store.load()
  return { store, dir }
}

test('reconcileTarget mirrors markdown entries and preserves created dates', async () => {
  const { store, dir } = await makeStore()

  const result = await store.reconcileTarget('memory', [
    encodeEntry('prefers pnpm', '2026-01-01', '2026-01-01'),
    encodeEntry('uses dark theme', '2026-01-02', '2026-01-02'),
  ])
  assert.equal(result.inserted, 2)
  assert.equal(store.getStats().total, 2)

  // 再次对账同一内容：existing，created 保留
  const again = await store.reconcileTarget('memory', [
    encodeEntry('prefers pnpm', '2026-01-01', '2026-02-01'),
    encodeEntry('uses dark theme', '2026-01-02', '2026-02-02'),
  ])
  assert.equal(again.inserted, 0)
  assert.equal(again.existing, 2)

  const searched = store.search('pnpm')
  assert.equal(searched.length, 1)
  assert.equal(searched[0]!.created, '2026-01-01')
  assert.equal(searched[0]!.lastReferenced, '2026-02-01')

  // 删除一条 → removed
  const removed = await store.reconcileTarget('memory', [
    encodeEntry('prefers pnpm', '2026-01-01', '2026-02-01'),
  ])
  assert.equal(removed.removed, 1)
  assert.equal(store.getStats().total, 1)
  await fs.rm(dir, { recursive: true, force: true })
})

test('search requires all terms (AND) and ranks word matches first', async () => {
  const { store, dir } = await makeStore()
  await store.reconcileTarget('memory', [
    encodeEntry('auth uses jwt tokens', '2026-01-01', '2026-01-01'),
    encodeEntry('auth setup with oauth', '2026-01-02', '2026-01-02'),
    encodeEntry('database connection string', '2026-01-03', '2026-01-03'),
  ])

  assert.equal(store.search('auth jwt').length, 1)
  assert.equal(store.search('auth').length, 2)
  assert.equal(store.search('database').length, 1)
  assert.equal(store.search('nonexistent').length, 0)
  assert.equal(store.search('auth oauth').length, 1)

  const ranked = store.search('auth')
  // 同分时按最近引用时间倒序（2026-01-02 在前）
  assert.equal(ranked[0]!.content, 'auth setup with oauth')
  assert.equal(ranked[1]!.content, 'auth uses jwt tokens')
  await fs.rm(dir, { recursive: true, force: true })
})

test('search supports CJK substrings', async () => {
  const { store, dir } = await makeStore()
  await store.reconcileTarget('memory', [
    encodeEntry('用户喜欢深色主题', '2026-01-01', '2026-01-01'),
    encodeEntry('项目使用 pnpm 工作区', '2026-01-02', '2026-01-02'),
  ])

  assert.equal(store.search('深色').length, 1)
  assert.equal(store.search('主题').length, 1)
  assert.equal(store.search('pnpm').length, 1)
  await fs.rm(dir, { recursive: true, force: true })
})

test('search filters by target, project, and category', async () => {
  const { store, dir } = await makeStore()
  await store.reconcileTarget('memory', [
    encodeEntry('global memory fact', '2026-01-01', '2026-01-01'),
  ], 'my-repo')
  await store.reconcileTarget('user', [
    encodeEntry('prefers concise answers', '2026-01-01', '2026-01-01'),
  ])
  await store.reconcileTarget('failure', [
    encodeEntry('[correction] use pnpm not npm — Failed: user corrected', '2026-01-01', '2026-01-01'),
  ])

  assert.equal(store.search('fact').length, 1)
  assert.equal(store.search('fact', { project: 'my-repo' }).length, 1)
  assert.equal(store.search('fact', { project: 'other' }).length, 0)
  assert.equal(store.search('concise', { target: 'user' }).length, 1)
  assert.equal(store.search('concise', { target: 'memory' }).length, 0)
  assert.equal(store.search('pnpm', { category: 'correction' }).length, 1)
  assert.equal(store.search('pnpm', { category: 'failure' }).length, 0)
  await fs.rm(dir, { recursive: true, force: true })
})

test('reconcileFailures splits entries by encoded project scope', async () => {
  const { store, dir } = await makeStore()
  const result = await store.reconcileFailures([
    encodeEntry('[failure] global failure', '2026-01-01', '2026-01-01'),
    encodeEntry('[failure] project failure', '2026-01-01', '2026-01-01', 'proj-a'),
  ])
  assert.equal(result.inserted, 2)

  const projectFailures = store.search('project failure')
  assert.equal(projectFailures.length, 1)
  assert.equal(projectFailures[0]!.project, 'proj-a')
  await fs.rm(dir, { recursive: true, force: true })
})

test('reconcileFiles reads markdown files from disk', async () => {
  const { store, dir } = await makeStore()
  const memoryFile = path.join(dir, 'MEMORY.md')
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(memoryFile, `entry one${ENTRY_DELIMITER}entry two`, 'utf-8')

  const result = await store.reconcileFiles([{ target: 'memory', filePath: memoryFile }])
  assert.equal(result.inserted, 2)
  assert.equal(store.search('entry').length, 2)
  await fs.rm(dir, { recursive: true, force: true })
})

test('persists to disk and reloads', async () => {
  const { store, dir } = await makeStore()
  await store.reconcileTarget('memory', [encodeEntry('durable fact', '2026-01-01', '2026-01-01')])

  const store2 = new ExtendedMemoryStore(dir)
  await store2.load()
  assert.equal(store2.getStats().total, 1)
  assert.equal(store2.search('durable').length, 1)
  await fs.rm(dir, { recursive: true, force: true })
})
