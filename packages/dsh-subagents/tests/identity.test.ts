import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildRuntimeName, parsePackageName, frontmatterNameForConfig, parseAliases, resolveAgentTarget } from '../src/agents/identity.ts'

test('buildRuntimeName: package prefix', () => {
  assert.equal(buildRuntimeName('scout'), 'scout')
  assert.equal(buildRuntimeName('scout', 'code-analysis'), 'code-analysis.scout')
})

test('parsePackageName: sanitization', () => {
  assert.deepEqual(parsePackageName(' Code Analysis '), { packageName: 'code-analysis' })
  assert.deepEqual(parsePackageName(''), {})
  assert.deepEqual(parsePackageName(false), {})
  assert.ok(parsePackageName('!!!').error)
})

test('frontmatterNameForConfig', () => {
  assert.equal(frontmatterNameForConfig({ name: 'code-analysis.scout', packageName: 'code-analysis' }), 'scout')
  assert.equal(frontmatterNameForConfig({ name: 'scout' }), 'scout')
})

test('parseAliases', () => {
  assert.deepEqual(parseAliases('explorer, code-scout'), { aliases: ['explorer', 'code-scout'] })
  assert.deepEqual(parseAliases(['A', 'B']), { aliases: ['a', 'b'] })
  assert.deepEqual(parseAliases(false), {})
  assert.ok(parseAliases('Bad Alias!').error)
})

test('resolveAgentTarget: canonical wins, alias resolves, ambiguity errors', () => {
  const agents = [
    { name: 'reviewer', aliases: ['r'] },
    { name: 'other', aliases: ['r'] },
    { name: 'scout', aliases: ['explorer'] },
  ]
  assert.deepEqual(resolveAgentTarget('reviewer', agents), { name: 'reviewer' })
  assert.deepEqual(resolveAgentTarget('explorer', agents), { name: 'scout', viaAlias: true })
  const ambiguous = resolveAgentTarget('r', agents)
  assert.ok(ambiguous.error?.includes('ambiguous'))
  assert.ok(resolveAgentTarget('nope', agents).error)
})
