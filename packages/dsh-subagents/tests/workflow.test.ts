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
