import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  checkNoStagedFiles,
  computeEvidenceStatus,
  gateToAcceptance,
  inferAcceptance,
  parseAcceptanceReport,
} from '../src/runs/acceptance.ts'
import type { AgentConfig, SubagentsParams } from '../src/types.ts'

function workerAgent(): AgentConfig {
  return { name: 'worker', localName: 'worker', description: '', systemPrompt: '', scope: 'builtin', acceptanceRole: 'writer' }
}

function readonlyAgent(): AgentConfig {
  return { name: 'reviewer', localName: 'reviewer', description: '', systemPrompt: '', scope: 'builtin', acceptanceRole: 'read-only' }
}

const params: SubagentsParams = { task: 'Implement the fix', agent: 'worker' }

test('inferAcceptance: read-only role attests', () => {
  const { spec } = inferAcceptance({ task: 'review this diff' }, readonlyAgent(), false)
  assert.equal(spec.level, 'attested')
})

test('inferAcceptance: writer checks with evidence', () => {
  const { spec } = inferAcceptance(params, workerAgent(), false)
  assert.equal(spec.level, 'checked')
  assert.ok(spec.evidence.includes('changed-files'))
})

test('inferAcceptance: risky async writer requires review', () => {
  const { spec } = inferAcceptance({ task: 'migrate the production database' }, workerAgent(), true)
  assert.equal(spec.level, 'checked')
  assert.ok(spec.review?.required)
})

test('inferAcceptance: explicit verified wins', () => {
  const { spec, inferred } = inferAcceptance({ task: 'x', acceptance: { level: 'verified', verify: [{ command: 'npm test' }] } }, workerAgent(), false)
  assert.equal(spec.level, 'verified')
  assert.equal(inferred, false)
})

test('inferAcceptance: bare none string rejected', () => {
  assert.throws(() => inferAcceptance({ task: 'x', acceptance: 'none' }, workerAgent(), false))
})

test('gateToAcceptance: single command verified', () => {
  const spec = gateToAcceptance('npm test')
  assert.equal(spec.level, 'verified')
  assert.equal(spec.verify[0]?.command, 'npm test')
})

test('parseAcceptanceReport: fenced JSON canonicalized', () => {
  const output = `Done.

\`\`\`acceptance-report
{
  "changed_files": ["src/a.ts", "src/b.ts"],
  "testsAddedOrUpdated": ["test/a.test.ts"],
  "commandsRun": [{ "command": "npm test", "exitCode": 0 }],
  "residual_risks": ["none"],
  "noStagedFiles": true
}
\`\`\`
`
  const report = parseAcceptanceReport(output)
  assert.ok(report)
  assert.deepEqual(report.changedFiles, ['src/a.ts', 'src/b.ts'])
  assert.deepEqual(report.testsAddedOrUpdated, ['test/a.test.ts'])
  assert.equal(report.commandsRun?.[0]?.command, 'npm test')
  assert.equal(report.commandsRun?.[0]?.exitCode, 0)
  assert.deepEqual(report.residualRisks, ['none'])
  assert.equal(report.noStagedFiles, true)
})

test('parseAcceptanceReport: no fence → undefined', () => {
  assert.equal(parseAcceptanceReport('just prose'), undefined)
})

test('computeEvidenceStatus transitions', () => {
  const acceptance = { level: 'checked' as const, criteria: [], evidence: ['changed-files', 'tests-added'], verify: [] }
  const report = { changedFiles: ['a'], testsAddedOrUpdated: ['t'] }
  assert.equal(computeEvidenceStatus(acceptance, undefined, [], {}), 'claimed')
  assert.equal(computeEvidenceStatus(acceptance, report, [], {}), 'checked')
  assert.equal(computeEvidenceStatus(acceptance, report, [], { required: true, reviewed: false }), 'review-required')
  assert.equal(computeEvidenceStatus(acceptance, report, [], { required: true, reviewed: true }), 'reviewed')
  const missing = computeEvidenceStatus(acceptance, { changedFiles: ['a'] }, [], {})
  assert.equal(missing, 'rejected')
  const verified = computeEvidenceStatus({ level: 'verified', criteria: [], evidence: [], verify: [] }, report, [{ passed: true, output: 'ok' }], {})
  assert.equal(verified, 'verified')
})

test('inferAcceptance: explicit verified without verify commands is rejected（对齐上游 verified 强制 ≥1 verify）', () => {
  assert.throws(() => inferAcceptance({ ...params, acceptance: 'verified' }, workerAgent(), false), /verified.*requires at least one verify/)
  assert.throws(() => inferAcceptance({ ...params, acceptance: { level: 'verified' } }, workerAgent(), false), /verified.*requires at least one verify/)
  // 带 verify 数组的显式 verified 通过
  const ok = inferAcceptance({ ...params, acceptance: { level: 'verified', verify: [{ command: 'npm test' }] } }, workerAgent(), false)
  assert.equal(ok.spec.level, 'verified')
  assert.equal(ok.spec.verify.length, 1)
})

test('checkNoStagedFiles: 真实 git 暂存区检查（对齐上游）', async () => {
  const { execFileSync } = await import('node:child_process')
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'dshsub-nsf-'))
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 't@t'], { cwd: dir })
    execFileSync('git', ['config', 'user.name', 't'], { cwd: dir })
    writeFileSync(join(dir, 'a.txt'), 'x')
    // 未跟踪文件不算 staged
    assert.equal(checkNoStagedFiles(dir).passed, true)
    // staged 文件 → 失败
    execFileSync('git', ['add', 'a.txt'], { cwd: dir })
    assert.equal(checkNoStagedFiles(dir).passed, false)
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir })
    assert.equal(checkNoStagedFiles(dir).passed, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
