import { test } from 'node:test'
import assert from 'node:assert/strict'
import { registerMinimalPresetIsolation, SUBAGENTS_GLOBAL_TOOLS } from '../src/presets.ts'

interface FakeAgent {
  session: { id: string }
  ctx: { tools: { restrict(filter: { deny: string[] }): () => void } }
  denyCalls: Array<{ deny: string[] }>
  restrictionDisposes: number
}

function agent(id: string): FakeAgent {
  const value: FakeAgent = {
    session: { id },
    denyCalls: [],
    restrictionDisposes: 0,
    ctx: { tools: { restrict: () => () => {} } },
  }
  value.ctx.tools.restrict = (filter) => {
    value.denyCalls.push(filter)
    let disposed = false
    return () => {
      if (disposed) return
      disposed = true
      value.restrictionDisposes++
    }
  }
  return value
}

function harness(withPresets = true) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const agents = new Map<string, FakeAgent>()
  const presets = new Map<object, string | undefined>()
  let listenerDisposes = 0
  const root = {
    on(event: string, listener: (...args: unknown[]) => void): () => void {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => {
        if (set.delete(listener)) listenerDisposes++
      }
    },
  }
  const ctx = {
    root,
    get(name: string): unknown {
      if (name === 'agentPresets') return withPresets ? { composedPreset: (agentCtx: object) => presets.get(agentCtx) } : undefined
      if (name === 'agents') return { get: (id: string) => agents.get(id), list: () => [...agents.values()] }
      return undefined
    },
  }
  const emit = (event: string, ...args: unknown[]) => {
    for (const listener of [...listeners.get(event) ?? []]) listener(...args)
  }
  return {
    ctx,
    seed(value: FakeAgent, preset: string | undefined) {
      agents.set(value.session.id, value)
      presets.set(value.ctx, preset)
    },
    setPreset(value: FakeAgent, preset: string | undefined) { presets.set(value.ctx, preset) },
    create(value: FakeAgent, preset: string | undefined) {
      agents.set(value.session.id, value)
      presets.set(value.ctx, preset)
      emit('agent/created', { agent: value })
    },
    select(value: FakeAgent, preset: string) {
      presets.set(value.ctx, preset)
      emit('agent-preset/selected', value.session.id, preset)
    },
    disposeAgent(value: FakeAgent) { emit('agent/disposed', { agent: value }); agents.delete(value.session.id) },
    listenerCount: () => [...listeners.values()].reduce((sum, set) => sum + set.size, 0),
    listenerDisposes: () => listenerDisposes,
  }
}

test('minimal agent gets the exact subagents deny list', () => {
  const h = harness()
  registerMinimalPresetIsolation(h.ctx as never)
  const value = agent('minimal')
  h.create(value, 'minimal')
  assert.deepEqual(value.denyCalls, [{ deny: [...SUBAGENTS_GLOBAL_TOOLS] }])
})

test('standard, code, uncomposed, and absent preset service stay unrestricted', () => {
  for (const preset of ['standard', 'code', undefined]) {
    const h = harness()
    registerMinimalPresetIsolation(h.ctx as never)
    const value = agent(String(preset))
    h.create(value, preset)
    assert.equal(value.denyCalls.length, 0)
  }
  const h = harness(false)
  registerMinimalPresetIsolation(h.ctx as never)
  const value = agent('absent')
  h.create(value, 'minimal')
  assert.equal(value.denyCalls.length, 0)
})

test('blank-session preset switches install, deduplicate, and remove restriction', () => {
  const h = harness()
  registerMinimalPresetIsolation(h.ctx as never)
  const value = agent('switch')
  h.create(value, 'standard')
  h.select(value, 'minimal')
  h.select(value, 'minimal')
  assert.equal(value.denyCalls.length, 1)
  assert.equal(value.restrictionDisposes, 0)
  h.select(value, 'code')
  assert.equal(value.restrictionDisposes, 1)
})

test('plugin reload hydrates restrictions for existing live minimal agents', () => {
  const h = harness()
  const value = agent('existing')
  h.seed(value, 'minimal')
  registerMinimalPresetIsolation(h.ctx as never)
  assert.equal(value.denyCalls.length, 1)
})

test('agent disposal and plugin cleanup release restrictions and root listeners', () => {
  const h = harness()
  const disposePlugin = registerMinimalPresetIsolation(h.ctx as never)
  const first = agent('first')
  h.create(first, 'minimal')
  h.disposeAgent(first)
  assert.equal(first.restrictionDisposes, 1)

  const second = agent('second')
  h.create(second, 'minimal')
  assert.equal(h.listenerCount(), 3)
  disposePlugin()
  assert.equal(second.restrictionDisposes, 1)
  assert.equal(h.listenerCount(), 0)
  assert.equal(h.listenerDisposes(), 3)
})
