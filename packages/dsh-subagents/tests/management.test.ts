import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { agentConfigFromManagementConfig, setAgentDisabled, type ManagementTarget } from '../src/agents/management.ts'
import type { AgentConfig } from '../src/types.ts'

function existing(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    name: 'x',
    localName: 'x',
    description: 'old',
    tools: ['read'],
    extensions: ['ext-one'],
    systemPrompt: 'Body.',
    scope: 'user',
    ...overrides,
  } as AgentConfig
}

test('update without tools keeps the existing allowlist (no silent privilege widening)', () => {
  const { config } = agentConfigFromManagementConfig({ description: 'new' }, existing())
  assert.equal(config?.description, 'new')
  assert.deepEqual(config?.tools, ['read'], 'omitted tools must fall back to existing allowlist')
  assert.deepEqual(config?.extensions, ['ext-one'], 'omitted extensions must fall back too')
})

test('update with tools overrides the allowlist', () => {
  const { config } = agentConfigFromManagementConfig({ tools: ['bash', 'write'] }, existing())
  assert.deepEqual(config?.tools, ['bash', 'write'])
})

test('create (no existing) still requires explicit tools; absent means inherit', () => {
  const { config } = agentConfigFromManagementConfig({ name: 'fresh', description: 'd' }, undefined)
  assert.equal(config?.name, 'fresh')
  assert.equal(config?.tools, undefined, 'create without tools keeps inherit semantics')
  assert.deepEqual(config?.tools, undefined)
})

test('setAgentDisabled: enable removes the entry entirely when nothing else remains', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'subagents-mgmt-'))
  try {
    const target: ManagementTarget = {
      scope: 'user',
      dir: path.join(dir, 'agents'),
      overridesFile: path.join(dir, 'overrides.json'),
    }
    await setAgentDisabled(target, 'probe', true)
    let overrides = JSON.parse(readFileSync(target.overridesFile, 'utf8')) as { agents: Record<string, { disabled?: boolean }> }
    assert.equal(overrides.agents['probe']?.disabled, true, 'disable must write disabled: true')

    await setAgentDisabled(target, 'probe', false)
    overrides = JSON.parse(readFileSync(target.overridesFile, 'utf8')) as { agents: Record<string, { disabled?: boolean }> }
    assert.equal(overrides.agents['probe'], undefined, 'enable must remove the empty entry, not leave a placeholder')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
