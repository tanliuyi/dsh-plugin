import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  HERMES_GLOBAL_TOOLS,
  isMinimalSessionPreset,
  registerMinimalPresetIsolation,
  resolveSessionPreset,
} from '../src/presets.ts'
import { setupBackgroundReview } from '../src/handlers/review.ts'
import { setupCorrectionDetector } from '../src/handlers/correction-detector.ts'
import { setupSessionFlush } from '../src/handlers/flush.ts'

function session(headerPreset?: string, selectedPresets: string[] = []) {
  return {
    id: 'sess-1',
    header: { agentPreset: headerPreset, cwd: '/tmp/proj' },
    events: selectedPresets.map((agentPreset) => ({ type: 'agent-preset/selected', data: { agentPreset } })),
  }
}

test('session preset resolver uses newest selection over creation header', () => {
  assert.equal(resolveSessionPreset(session('minimal')), 'minimal')
  assert.equal(resolveSessionPreset(session(undefined)), undefined)
  assert.equal(resolveSessionPreset(session('standard', ['minimal'])), 'minimal')
  assert.equal(resolveSessionPreset(session('minimal', ['code', 'standard'])), 'standard')
  assert.equal(isMinimalSessionPreset(session('standard', ['minimal'])), true)
  assert.equal(isMinimalSessionPreset(session('minimal', ['code'])), false)
})

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

function isolationHarness(withPresets = true) {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const agents = new Map<string, FakeAgent>()
  const presets = new Map<object, string | undefined>()
  const ctx = {
    root: {
      on(event: string, listener: (...args: unknown[]) => void): () => void {
        const set = listeners.get(event) ?? new Set()
        set.add(listener)
        listeners.set(event, set)
        return () => { set.delete(listener) }
      },
    },
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
  }
}

test('minimal Hermes agent gets exact deny list; other presets stay untouched', () => {
  const h = isolationHarness()
  registerMinimalPresetIsolation(h.ctx as never)
  const minimal = agent('minimal')
  h.create(minimal, 'minimal')
  assert.deepEqual(minimal.denyCalls, [{ deny: [...HERMES_GLOBAL_TOOLS] }])
  for (const preset of ['standard', 'code', undefined]) {
    const value = agent(String(preset))
    h.create(value, preset)
    assert.equal(value.denyCalls.length, 0)
  }
  const absent = isolationHarness(false)
  registerMinimalPresetIsolation(absent.ctx as never)
  const value = agent('absent')
  absent.create(value, 'minimal')
  assert.equal(value.denyCalls.length, 0)
})

test('Hermes restriction follows blank-session switches and is idempotent', () => {
  const h = isolationHarness()
  registerMinimalPresetIsolation(h.ctx as never)
  const value = agent('switch')
  h.create(value, 'standard')
  h.select(value, 'minimal')
  h.select(value, 'minimal')
  assert.equal(value.denyCalls.length, 1)
  h.select(value, 'code')
  assert.equal(value.restrictionDisposes, 1)
})

test('Hermes plugin reload hydrates existing live minimal agents', () => {
  const h = isolationHarness()
  const value = agent('existing')
  h.seed(value, 'minimal')
  registerMinimalPresetIsolation(h.ctx as never)
  assert.equal(value.denyCalls.length, 1)
})

test('Hermes agent and plugin disposal release restrictions and listeners', () => {
  const h = isolationHarness()
  const disposePlugin = registerMinimalPresetIsolation(h.ctx as never)
  const first = agent('first')
  h.create(first, 'minimal')
  h.disposeAgent(first)
  assert.equal(first.restrictionDisposes, 1)
  const second = agent('second')
  h.create(second, 'minimal')
  disposePlugin()
  assert.equal(second.restrictionDisposes, 1)
  assert.equal(h.listenerCount(), 0)
})

function throwingRuntime() {
  const explode = () => { throw new Error('work happened on a minimal session') }
  return {
    config: {
      reviewEnabled: true, nudgeInterval: 0, nudgeToolCalls: 0, reviewRecentMessages: 0,
      flushMinTurns: 0, flushOnCompact: true, flushOnShutdown: true, flushRecentMessages: 0,
      correctionDetection: true,
    },
    store: { getMemoryEntries: explode, getUserEntries: explode, addFailure: explode },
    projectStores: { resolve: explode },
    llm: {},
  }
}

function captureCtx() {
  const listeners: Record<string, (...args: unknown[]) => void> = {}
  return {
    ctx: { on(event: string, fn: (...args: unknown[]) => void) { listeners[event] = fn; return () => {} } },
    fire(event: string, ...args: unknown[]) { listeners[event]?.(...args) },
  }
}

test('automatic review, correction, and flush skip minimal sessions', () => {
  const minimal = session('minimal')
  const review = captureCtx()
  setupBackgroundReview(review.ctx as never, throwingRuntime() as never)
  assert.doesNotThrow(() => review.fire('session/event', minimal, { type: 'turn/end' }))

  const correction = captureCtx()
  setupCorrectionDetector(correction.ctx as never, throwingRuntime() as never)
  assert.doesNotThrow(() => correction.fire('session/event', minimal, { type: 'user/message' }))

  const flush = captureCtx()
  setupSessionFlush(flush.ctx as never, throwingRuntime() as never)
  assert.doesNotThrow(() => flush.fire('session/event', minimal, { type: 'compaction/start' }))
  assert.doesNotThrow(() => flush.fire('agent/disposed', { agent: { session: minimal } }))
})
