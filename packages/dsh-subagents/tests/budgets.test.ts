import { test } from 'node:test'
import assert from 'node:assert/strict'

import { SpawnBudget, RunTreeBudget, ActiveAsyncCapacity, depthError } from '../src/runs/budgets.ts'
import { DEFAULT_MAX_SPAWNS_PER_RUN } from '../src/types.ts'

test('SpawnBudget: unlimited by default', () => {
  const budget = new SpawnBudget(undefined)
  assert.ok(budget.canSpawn())
  assert.ok(budget.charge())
  assert.equal(budget.usage.effectiveLimit, undefined)
})

test('SpawnBudget: capped and grants', () => {
  const budget = new SpawnBudget(3)
  assert.ok(budget.charge())
  assert.ok(budget.charge())
  assert.ok(budget.charge())
  assert.equal(budget.canSpawn(), false)
  assert.equal(budget.charge(), false)
  const grant = budget.grant(2)
  assert.ok(grant.ok)
  assert.ok(budget.canSpawn()) // 容量 = limit + grants = 5
  assert.ok(budget.charge())   // used=4
  assert.ok(budget.charge())   // used=5
  assert.equal(budget.canSpawn(), false)
  assert.ok(budget.grant(5).error) // grants 不能超过原上限
})

test('SpawnBudget: grants rejected for unlimited', () => {
  const budget = new SpawnBudget(undefined)
  assert.ok(budget.grant(1).error)
})

test('RunTreeBudget: default 64', () => {
  const budget = new RunTreeBudget(undefined)
  assert.equal(budget.limit, DEFAULT_MAX_SPAWNS_PER_RUN)
  for (let i = 0; i < 64; i++) assert.ok(budget.charge())
  assert.equal(budget.canSpawn(), false)
})

test('ActiveAsyncCapacity: reserve/release', () => {
  const capacity = new ActiveAsyncCapacity(2)
  assert.ok(capacity.reserve())
  assert.ok(capacity.reserve())
  assert.equal(capacity.reserve(), false)
  capacity.release()
  assert.ok(capacity.reserve())
})

test('depthError', () => {
  assert.equal(depthError(0, 2), undefined)
  assert.equal(depthError(1, 2), undefined)
  assert.ok(depthError(2, 2)?.includes('depth limit'))
})
