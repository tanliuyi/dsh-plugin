import test from 'node:test'
import assert from 'node:assert/strict'

import { deriveThreadListProjection } from '../web/src/dsh/thread-list.ts'
import type { SessionView, ThreadListViewState } from '../web/src/dsh/store.ts'
import type { WorkspaceView } from '../web/src/dsh/api.ts'

const view: ThreadListViewState = {
  groupBy: 'workspace',
  orderBy: 'manual',
  expandedGroups: ['workspace-1', ''],
}

function session(sessionId: string, overrides: Partial<SessionView> = {}): SessionView {
  return {
    sessionId,
    title: sessionId,
    updatedAt: 1,
    running: false,
    blank: false,
    ...overrides,
  }
}

const workspace: WorkspaceView = {
  workspaceId: 'workspace-1',
  path: '/workspace',
  title: 'Workspace',
  sessionIds: ['parent-1'],
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
}

test('subagent sessions are nested under their parent instead of Ungrouped', () => {
  const projection = deriveThreadListProjection([
    session('parent-1'),
    session('child-1', {
      origin: 'subagent',
      parentSessionId: 'parent-1',
      subagentMode: 'continuable',
    }),
    session('grandchild-1', {
      origin: 'subagent',
      parentSessionId: 'child-1',
      subagentMode: 'one-shot',
    }),
  ], [workspace], [], view)

  assert.deepEqual(projection.groups.map((group) => [group.label, group.sessionIds]), [
    ['Workspace', ['parent-1']],
  ])
  assert.deepEqual(projection.childrenByParent, {
    'parent-1': ['child-1'],
    'child-1': ['grandchild-1'],
  })
  assert.deepEqual(
    projection.sessions.map((item) => item.sessionId),
    ['parent-1', 'child-1', 'grandchild-1'],
  )
})

test('ordinary forks and orphaned subagents remain top-level sessions', () => {
  const projection = deriveThreadListProjection([
    session('parent-1'),
    session('ordinary-fork', { parentSessionId: 'parent-1' }),
    session('orphan-child', {
      origin: 'subagent',
      parentSessionId: 'missing-parent',
    }),
  ], [workspace], [], view)

  assert.deepEqual(projection.childrenByParent, {})
  assert.deepEqual(projection.groups.map((group) => [group.label, group.sessionIds]), [
    ['Workspace', ['parent-1']],
    ['Ungrouped', ['ordinary-fork', 'orphan-child']],
  ])
})
