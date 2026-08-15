import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
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
