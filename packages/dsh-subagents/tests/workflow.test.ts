import { test } from 'node:test'
import assert from 'node:assert/strict'

import { workflowLaneKeys, renderTemplate, loadPromptTemplate } from '../src/runs/workflow.ts'

test('workflowLaneKeys: runs.run keys', () => {
  const keys = workflowLaneKeys('const scan = await runs.run("scan", { agent: "scout" }); return scan.output')
  assert.deepEqual(keys, ['scan'])
})

test('workflowLaneKeys: runs.all keys', () => {
  const keys = workflowLaneKeys(`const results = await runs.all([
    { key: "backend", agent: "reviewer", task: "Review backend" },
    { key: "frontend", agent: "reviewer", task: "Review frontend" }
  ]); return results`)
  assert.deepEqual(keys, ['backend', 'frontend'])
})

test('workflowLaneKeys: mixed and deduped', () => {
  const keys = workflowLaneKeys(`
    const a = await runs.run("scan", { agent: "scout", task: "x" });
    const b = await runs.all([{ key: "one", agent: "reviewer" }, { key: "two", agent: "reviewer" }]);
    const c = await runs.run("scan", { agent: "scout", task: "again" });
  `)
  assert.deepEqual(keys, ['scan', 'one', 'two'])
})

test('workflowLaneKeys: ignores comments and dynamic keys', () => {
  const keys = workflowLaneKeys(`
    // runs.run("ignored", { agent: "x" })
    const key = "dynamic";
    const r = await runs.run(key, { agent: "scout" });
  `)
  assert.deepEqual(keys, [])
})

test('renderTemplate replaces scalars', () => {
  assert.equal(renderTemplate('Review {{previous}} for pass {{pass}}', { previous: 'output', pass: 2 }), 'Review output for pass 2')
  assert.equal(renderTemplate('Keep {{missing}}', {}), 'Keep {{missing}}')
})

test('loadPromptTemplate: package prompts with frontmatter stripped', async () => {
  const dir = new URL('../prompts/', import.meta.url).pathname
  const body = await loadPromptTemplate('package:parallel-review', { package: dir, user: '', project: '' })
  assert.ok(body)
  assert.ok(body.includes('Launch parallel reviewers'))
  assert.ok(!body.startsWith('---'))
})

test('loadPromptTemplate: unknown ref undefined', async () => {
  const body = await loadPromptTemplate('package:no-such-template', { package: '/tmp', user: '', project: '' })
  assert.equal(body, undefined)
})

test('packagePromptsDir resolves to the shipped prompts dir', async () => {
  const { packagePromptsDir } = await import('../src/runs/execution.ts')
  const dir = await packagePromptsDir()
  const { readFile } = await import('node:fs/promises')
  const body = await readFile(`${dir}/parallel-review.md`, 'utf8')
  assert.ok(body.includes('Launch parallel reviewers'))
})

test('runs.status / runs.ref / runs.refs: 查询与引用（对齐上游）', async () => {
  const { runWorkflowScript } = await import('../src/runs/workflow.ts')
  const result = await runWorkflowScript({
    script: `
      const a = await runs.run('alpha', { agent: 'delegate', task: 't1' })
      const byKey = runs.status('alpha')
      const byId = runs.status(a.runId ?? 'nope')
      return {
        byKey: byKey?.status,
        byId: byId?.key,
        ref: runs.ref(a),
        refs: runs.refs([a]),
      }
    `,
    run: {} as never,
    params: {} as never,
    promptDirs: { package: '', user: '', project: '' },
    onSpawn: async (key) => ({ key, agent: 'delegate', runId: `run-${key}`, output: 'ok', status: 'completed', artifactPaths: {} }),
  })
  const value = result.value as { byKey?: string; byId?: string; ref: string; refs: string }
  assert.equal(value.byKey, 'completed')
  assert.equal(value.byId, 'alpha')
  assert.ok(value.ref.includes('run alpha'))
  assert.ok(value.ref.includes('id=run-alph'))
  assert.ok(value.refs.includes('run alpha'))
})

test('runs.run: 同 key 指纹校验（同一 key 不兼容参数报错，对齐上游）', async () => {
  const { runWorkflowScript } = await import('../src/runs/workflow.ts')
  const result = await runWorkflowScript({
    script: `
      await runs.run('dup', { agent: 'delegate', task: 't1' })
      try {
        await runs.run('dup', { agent: 'delegate', task: 'DIFFERENT' })
        return { rejected: false }
      } catch (error) {
        return { rejected: true, message: String(error) }
      }
    `,
    run: {} as never,
    params: {} as never,
    promptDirs: { package: '', user: '', project: '' },
    onSpawn: async (key) => ({ key, agent: 'delegate', runId: `run-${key}`, output: 'ok', status: 'completed', artifactPaths: {} }),
  })
  const value = result.value as { rejected?: boolean; message?: string }
  assert.equal(value.rejected, true)
  assert.ok(value.message!.includes('Duplicate workflow key'))
})

test('runs.run: 非法 key 与禁止参数校验', async () => {
  const { runWorkflowScript } = await import('../src/runs/workflow.ts')
  const result = await runWorkflowScript({
    script: `
      try { await runs.run('bad key!', { agent: 'delegate', task: 't' }); return { a: 'not-rejected' } } catch (e) { }
      try { await runs.run('k', { agent: 'delegate', task: 't', workflowScript: 'x' }); return { b: 'not-rejected' } } catch (e) { }
      return { a: 'rejected', b: 'rejected' }
    `,
    run: {} as never,
    params: {} as never,
    promptDirs: { package: '', user: '', project: '' },
    onSpawn: async (key) => ({ key, agent: 'delegate', runId: `run-${key}`, output: 'ok', status: 'completed', artifactPaths: {} }),
  })
  const value = result.value as { a?: string; b?: string }
  assert.equal(value.a, 'rejected')
  assert.equal(value.b, 'rejected')
})
