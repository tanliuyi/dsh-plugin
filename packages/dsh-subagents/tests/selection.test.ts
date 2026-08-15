import { test } from 'node:test'
import assert from 'node:assert/strict'

import { selectAgent } from '../src/agents/selection.ts'
import type { AgentConfig } from '../src/types.ts'

function makeAgent(name: string, description: string): AgentConfig {
  return {
    name,
    localName: name,
    description,
    systemPrompt: 'body',
    scope: 'builtin',
  }
}

function stubCtx(): any {
  return { get: () => undefined } // 无 llm → 启发式
}

test('heuristic: review task picks reviewer', async () => {
  const agents = [
    makeAgent('reviewer', 'Code review'),
    makeAgent('worker', 'Implementation'),
    makeAgent('scout', 'Recon'),
  ]
  const result = await selectAgent(stubCtx(), 'Please review this diff for correctness', agents)
  assert.equal(result.agent?.name, 'reviewer')
  assert.equal(result.viaLlm, false)
})

test('heuristic: implement task picks worker', async () => {
  const agents = [makeAgent('reviewer', 'Code review'), makeAgent('worker', 'Implementation'), makeAgent('scout', 'Recon')]
  const result = await selectAgent(stubCtx(), 'Implement the fix and write tests', agents)
  assert.equal(result.agent?.name, 'worker')
})

test('heuristic: research task picks researcher', async () => {
  const agents = [makeAgent('researcher', 'Web research'), makeAgent('worker', 'Implementation')]
  const result = await selectAgent(stubCtx(), 'Research the latest API docs', agents)
  assert.equal(result.agent?.name, 'researcher')
})

test('prefer option wins over heuristics', async () => {
  const agents = [makeAgent('reviewer', 'Code review'), makeAgent('worker', 'Implementation')]
  const result = await selectAgent(stubCtx(), 'implement something', agents, { prefer: 'reviewer' })
  assert.equal(result.agent?.name, 'reviewer')
})

test('no agents → error', async () => {
  const result = await selectAgent(stubCtx(), 'anything', [])
  assert.ok(result.error)
})

test('alias in prefer resolves', async () => {
  const oracle = makeAgent('oracle', 'Second opinion')
  oracle.aliases = ['advisor']
  const result = await selectAgent(stubCtx(), 'do work', [oracle], { prefer: 'advisor' })
  assert.equal(result.agent?.name, 'oracle')
})
