import type { WorkspaceView } from './api'
import type { SessionView, ThreadListViewState } from './store'

export interface ThreadListGroup {
  key: string
  workspaceId?: string
  label: string
  path?: string
  sessionIds: string[]
  expanded: boolean
}

export interface ThreadListProjection {
  sessions: SessionView[]
  groups: ThreadListGroup[]
  childrenByParent: Record<string, string[]>
}

function sessionOrder(ids: readonly string[], byId: Map<string, SessionView>, orderBy: ThreadListViewState['orderBy']): string[] {
  const result = ids.filter((id) => byId.has(id))
  if (orderBy !== 'updated') return result
  return result.sort((a, b) => {
    const updatedDiff = (byId.get(b)?.updatedAt ?? 0) - (byId.get(a)?.updatedAt ?? 0)
    return updatedDiff !== 0 ? updatedDiff : a.localeCompare(b)
  })
}

function workspaceLabel(workspace: WorkspaceView): string {
  return workspace.title || workspace.path.split(/[\\/]/).filter(Boolean).pop() || workspace.path
}

export function deriveThreadListProjection(sessions: readonly SessionView[], workspaces: readonly WorkspaceView[], archivedSessionIds: readonly string[], view: ThreadListViewState): ThreadListProjection {
  const archived = new Set(archivedSessionIds)
  const visible = sessions.filter((session) => !session.blank && !archived.has(session.sessionId))
  const byId = new Map(visible.map((session) => [session.sessionId, session]))
  const childIds = new Set<string>()
  const childrenByParentMap = new Map<string, string[]>()

  for (const session of visible) {
    if (session.origin !== 'subagent' || !session.parentSessionId || !byId.has(session.parentSessionId)) continue
    childIds.add(session.sessionId)
    const children = childrenByParentMap.get(session.parentSessionId) ?? []
    children.push(session.sessionId)
    childrenByParentMap.set(session.parentSessionId, children)
  }
  for (const [parentId, ids] of childrenByParentMap) {
    childrenByParentMap.set(parentId, sessionOrder(ids, byId, view.orderBy))
  }
  const childrenByParent = Object.fromEntries(childrenByParentMap)

  const appendTree = (sessionId: string, ordered: SessionView[], seen: Set<string>) => {
    if (seen.has(sessionId)) return
    const session = byId.get(sessionId)
    if (!session) return
    seen.add(sessionId)
    ordered.push(session)
    for (const childId of childrenByParent[sessionId] ?? []) appendTree(childId, ordered, seen)
  }

  if (view.groupBy === 'flat') {
    const rootIds = sessionOrder(visible.filter((session) => !childIds.has(session.sessionId)).map((session) => session.sessionId), byId, 'updated')
    const flat: SessionView[] = []
    const seen = new Set<string>()
    for (const rootId of rootIds) appendTree(rootId, flat, seen)
    return { sessions: flat, groups: [], childrenByParent }
  }

  const accounted = new Set<string>()
  const groups: ThreadListGroup[] = []
  const orderedSessions: SessionView[] = []
  const orderedSeen = new Set<string>()

  for (const workspace of workspaces) {
    const ids = workspace.sessionIds.filter((id) => {
      if (childIds.has(id)) return false
      accounted.add(id)
      return byId.has(id)
    })
    const sessionIds = sessionOrder(ids, byId, view.orderBy)
    for (const id of sessionIds) appendTree(id, orderedSessions, orderedSeen)
    groups.push({ key: workspace.workspaceId, workspaceId: workspace.workspaceId, label: workspaceLabel(workspace), path: workspace.path, sessionIds, expanded: view.expandedGroups.includes(workspace.workspaceId) })
  }

  const ungroupedIds = visible
    .filter((session) => !childIds.has(session.sessionId) && !accounted.has(session.sessionId))
    .map((session) => session.sessionId)
  const ungroupedSessionIds = sessionOrder(ungroupedIds, byId, view.orderBy)
  if (ungroupedSessionIds.length > 0) {
    for (const id of ungroupedSessionIds) appendTree(id, orderedSessions, orderedSeen)
    groups.push({ key: '', label: 'Ungrouped', sessionIds: ungroupedSessionIds, expanded: view.expandedGroups.includes('') })
  }

  return { sessions: orderedSessions, groups, childrenByParent }
}
