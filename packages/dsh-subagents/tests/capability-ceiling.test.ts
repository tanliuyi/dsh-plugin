/**
 * capability-ceiling 单元测试（对齐上游 pi-subagents src/runs/shared/capability-ceiling.ts）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Config, normalizeConfig } from '../src/config.ts'
import {
  SUBAGENT_CAPABILITY_CEILING_VERSION,
  capabilityCeilingAgentRestrictionMessage,
  intersectSubagentCapabilityCeilings,
  isAgentAllowedByCapabilityCeiling,
  isToolAllowedByCapabilityCeiling,
  normalizeCeiling,
} from '../src/runs/capability-ceiling.ts'

test('normalizeCeiling: 校验形状', () => {
  assert.throws(() => normalizeCeiling({} as never), /expected allowedTools, allowedAgents, or denyExtensions/)
  assert.throws(() => normalizeCeiling({ allowedTools: 'x' } as never), /expected an array/)
  assert.throws(() => normalizeCeiling({ allowedTools: [''] }), /non-empty string/)
  assert.throws(() => normalizeCeiling({ allowedTools: ['bad name'] }), /Invalid capability ceiling allowedTools entry/)
  assert.throws(() => normalizeCeiling({ denyExtensions: 'yes' } as never), /denyExtensions; expected a boolean/)
})

test('normalizeCeiling: 正常规范化与去重排序', () => {
  const c = normalizeCeiling({ allowedTools: ['edit', 'read', 'edit'] })
  assert.equal(c.version, SUBAGENT_CAPABILITY_CEILING_VERSION)
  assert.deepEqual(c.allowedTools, ['edit', 'read'])
  assert.equal(c.denyExtensions, false)
  const c2 = normalizeCeiling({ allowedAgents: ['worker', 'reviewer'], denyExtensions: true })
  assert.deepEqual(c2.allowedAgents, ['reviewer', 'worker'])
  assert.equal(c2.denyExtensions, true)
})

test('intersectSubagentCapabilityCeilings: 交集语义', () => {
  const a = normalizeCeiling({ allowedTools: ['read', 'edit', 'bash'] })
  const b = normalizeCeiling({ allowedTools: ['read', 'bash', 'grep'] })
  const merged = intersectSubagentCapabilityCeilings(a, b)
  assert.deepEqual(merged?.allowedTools, ['bash', 'read'])
  // 单源
  const single = intersectSubagentCapabilityCeilings(a)
  assert.deepEqual(single?.allowedTools, ['bash', 'edit', 'read'])
  // 全空
  assert.equal(intersectSubagentCapabilityCeilings(undefined, undefined), undefined)
})

test('isAgentAllowedByCapabilityCeiling: 无 allowedAgents 全允许', () => {
  const ceiling = normalizeCeiling({ allowedTools: ['read'] })
  assert.equal(isAgentAllowedByCapabilityCeiling('worker', ceiling), true)
  const restricted = normalizeCeiling({ allowedAgents: ['worker'] })
  assert.equal(isAgentAllowedByCapabilityCeiling('worker', restricted), true)
  assert.equal(isAgentAllowedByCapabilityCeiling('reviewer', restricted), false)
})

test('isToolAllowedByCapabilityCeiling: allowedTools 过滤', () => {
  const ceiling = normalizeCeiling({ allowedTools: ['read', 'edit'] })
  assert.equal(isToolAllowedByCapabilityCeiling('edit', ceiling), true)
  assert.equal(isToolAllowedByCapabilityCeiling('bash', ceiling), false)
  assert.equal(isToolAllowedByCapabilityCeiling('bash', undefined), true)
})

test('capabilityCeilingAgentRestrictionMessage: 诊断文案', () => {
  const ceiling = normalizeCeiling({ allowedAgents: ['worker'] })
  ceiling.sources = ['test-config']
  const message = capabilityCeilingAgentRestrictionMessage('reviewer', ceiling)
  assert.match(message ?? '', /does not allow agent 'reviewer'/)
  assert.match(message ?? '', /Allowed agents: worker/)
  assert.equal(capabilityCeilingAgentRestrictionMessage('worker', ceiling), undefined)
  assert.doesNotThrow(() => capabilityCeilingAgentRestrictionMessage('reviewer', { allowedAgents: ['worker'] } as never))
})

test('normalizeConfig: omitted capability ceiling does not deny every agent', () => {
  const parsed = Config({})
  assert.deepEqual(parsed.capabilityCeiling, {})
  assert.equal(normalizeConfig(parsed).capabilityCeiling, undefined)
})

test('normalizeConfig: omitted allowlist siblings stay absent', () => {
  const parsed = Config({ capabilityCeiling: { allowedTools: ['read'] } })
  assert.deepEqual(parsed.capabilityCeiling, { allowedTools: ['read'] })
  const ceiling = normalizeConfig(parsed).capabilityCeiling
  assert.deepEqual(ceiling?.allowedTools, ['read'])
  assert.equal(ceiling?.allowedAgents, undefined)
  assert.deepEqual(ceiling?.sources, [])
})

test('normalizeConfig: explicit empty allowedAgents remains deny-all', () => {
  const parsed = Config({ capabilityCeiling: { allowedAgents: [] } })
  const ceiling = normalizeConfig(parsed).capabilityCeiling
  assert.deepEqual(ceiling?.allowedAgents, [])
  assert.equal(isAgentAllowedByCapabilityCeiling('worker', ceiling), false)
})
