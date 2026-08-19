import test from 'node:test'
import assert from 'node:assert/strict'

import { useDsh } from '../web/src/dsh/store.ts'

/**
 * boot 回归测试：首次 boot 时若 (localStorage) 无有效 currentSessionId，UI 必须
 * 以「复用当前 workspace 的 blank session，否则新建并 open」收尾，不允许停留在
 * 无 session 状态，也不允许重复创建。经 tests/setup.mjs 注册的 resolver 让
 * store.ts 的扩展名省略 import 可在 node --test 下解析（生产构建不受影响）。
 */

interface MockedCall {
  method: string
  payload: unknown
}

const calls: MockedCall[] = []
let sessionCreateCount = 0
let sessionHistoryCalls: string[] = []
let sessionItems: Array<Record<string, unknown>> = []
let workspaceItems: Array<Record<string, unknown>> = []

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } })
}

function installFetch(t: test.Context): void {
  const original = globalThis.fetch
  calls.length = 0
  sessionCreateCount = 0
  sessionHistoryCalls = []

  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { rpcId: string; method: string; payload: unknown }
    const { rpcId, method, payload } = request
    calls.push({ method, payload })

    let result: unknown
    switch (method) {
      case 'host.describe':
        result = { ok: true, value: { version: 'test', cwd: '/workspace' } }
        break
      // 旧 host 可能不暴露，boot 内已 try/catch；用结构化 err 表示不支持。
      case 'llm.models':
      case 'agentPreset.list':
        result = { ok: false, error: { code: 'unsupported', message: 'n/a' } }
        break
      case 'session.list':
        result = { ok: true, value: { items: sessionItems } }
        break
      case 'workspace.list':
        result = { ok: true, value: { items: workspaceItems } }
        break
      case 'session.create': {
        sessionCreateCount += 1
        const created = { sessionId: 'new-1', cwd: '/workspace', blank: true, updatedAt: 2, running: false } as Record<string, unknown>
        // 模拟 host 创建后即出现在 session/workspace 注册表中。
        sessionItems = [...sessionItems, created]
        workspaceItems = workspaceItems.map((w) =>
          w.workspaceId === 'ws-1' ? { ...w, sessionIds: [...(w.sessionIds as string[]), 'new-1'] } : w,
        )
        result = { ok: true, value: { sessionId: 'new-1' } }
        break
      }
      case 'session.history': {
        sessionHistoryCalls.push((payload as { sessionId: string }).sessionId)
        result = { ok: true, value: { events: [] } }
        break
      }
      case 'commands/list':
        result = { ok: true, value: [] }
        break
      case 'skill.list':
        result = { ok: true, value: { skills: [] } }
        break
      case 'session.models':
        result = { ok: true, value: { groups: [], current: { provider: 'test', model: 'm' }, routable: true } }
        break
      default:
        throw new Error(`unexpected rpc method in store test: ${method}`)
    }
    return jsonResponse({ type: 'server-response', rpcId, result })
  }

  t.after(() => { globalThis.fetch = original })
}

function resetStore(currentSessionId: string | null): void {
  useDsh.setState({
    booting: true,
    connected: false,
    host: null,
    sessions: [],
    workspaces: [],
    archivedSessionIds: [],
    agentPresets: [],
    settings: null,
    newSessionWorkspaceId: null,
    newSessionAgentPreset: null,
    permissions: null,
    newSessionPermissionPreset: null,
    currentSessionId,
    goal: null,
    todos: undefined,
    planMode: false,
    contextUsage: undefined,
    messages: [],
    lastEventSeqBySession: {},
    isRunning: false,
    loadingHistory: false,
    error: null,
    commands: [],
    commandsSessionId: null,
    commandLoadError: null,
    skills: [],
    skillsSessionId: null,
  })
}

function session(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { sessionId: id, cwd: '/workspace', blank: false, updatedAt: 1, running: false, ...overrides }
}

test('boot: a valid restored session id is opened directly, never re-created', async (t) => {
  installFetch(t)
  sessionItems = [session('restored-1')]
  workspaceItems = [{ workspaceId: 'ws-1', path: '/workspace', sessionIds: ['restored-1'] }]
  resetStore('restored-1')

  await useDsh.getState().boot()

  assert.equal(useDsh.getState().currentSessionId, 'restored-1')
  assert.equal(useDsh.getState().booting, false)
  assert.equal(useDsh.getState().error, null)
  assert.equal(sessionCreateCount, 0)
  assert.deepEqual(sessionHistoryCalls, ['restored-1'])
})

test('boot: no stored id reuses the current workspace blank session, no create', async (t) => {
  installFetch(t)
  sessionItems = [session('blank-1', { blank: true })]
  workspaceItems = [{ workspaceId: 'ws-1', path: '/workspace', sessionIds: ['blank-1'] }]
  resetStore(null)

  await useDsh.getState().boot()

  assert.equal(useDsh.getState().currentSessionId, 'blank-1')
  assert.equal(useDsh.getState().booting, false)
  assert.equal(sessionCreateCount, 0)
  assert.deepEqual(sessionHistoryCalls, ['blank-1'])
})

test('boot: without a reusable blank session it creates exactly one and opens it', async (t) => {
  installFetch(t)
  sessionItems = []
  workspaceItems = [{ workspaceId: 'ws-1', path: '/workspace', sessionIds: [] }]
  resetStore(null)

  await useDsh.getState().boot()

  assert.equal(useDsh.getState().currentSessionId, 'new-1')
  assert.equal(useDsh.getState().booting, false)
  // 不允许重复创建（createSession(false) 内部复用 + create 只走一条路径）。
  assert.equal(sessionCreateCount, 1)
  assert.deepEqual(sessionHistoryCalls, ['new-1'])
})

test('boot: a stale stored id is cleared and the workspace blank session is used', async (t) => {
  installFetch(t)
  sessionItems = [session('blank-1', { blank: true })]
  workspaceItems = [{ workspaceId: 'ws-1', path: '/workspace', sessionIds: ['blank-1'] }]
  resetStore('stale-99')

  await useDsh.getState().boot()

  assert.equal(useDsh.getState().currentSessionId, 'blank-1')
  assert.equal(useDsh.getState().booting, false)
  // 陈旧 id 不得再被打开。
  assert.equal(sessionHistoryCalls.includes('stale-99'), false)
  assert.equal(sessionCreateCount, 0)
  assert.deepEqual(sessionHistoryCalls, ['blank-1'])
})

test('boot: a stale stored id with no blank session creates and opens a new session', async (t) => {
  installFetch(t)
  // 仅存在其它 workspace 的 blank（cwd 不匹配当前 workspace），因此必须新建。
  sessionItems = [session('other-1', { blank: true, cwd: '/other' })]
  workspaceItems = [{ workspaceId: 'ws-1', path: '/workspace', sessionIds: [] }]
  resetStore('stale-98')

  await useDsh.getState().boot()

  assert.equal(useDsh.getState().currentSessionId, 'new-1')
  assert.equal(useDsh.getState().booting, false)
  assert.equal(sessionHistoryCalls.includes('stale-98'), false)
  assert.equal(sessionCreateCount, 1)
  assert.deepEqual(sessionHistoryCalls, ['new-1'])
})

test('boot: a valid thread URL takes precedence over the persisted session id', async (t) => {
  installFetch(t)
  sessionItems = [session('restored-1'), session('url-1')]
  workspaceItems = [{ workspaceId: 'ws-1', path: '/workspace', sessionIds: ['restored-1', 'url-1'] }]
  resetStore('restored-1')

  await useDsh.getState().boot('url-1')

  assert.equal(useDsh.getState().currentSessionId, 'url-1')
  assert.equal(sessionCreateCount, 0)
  assert.deepEqual(sessionHistoryCalls, ['url-1'])
})
