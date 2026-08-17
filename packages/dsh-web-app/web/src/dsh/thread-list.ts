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
  const byId = new Map(sessions.filter((session) => !session.blank && !archived.has(session.sessionId)).map((session) => [session.sessionId, session]))

  if (view.groupBy === 'flat') {
    const flat = [...byId.values()].sort((a, b) => {
      const updatedDiff = b.updatedAt - a.updatedAt
      return updatedDiff !== 0 ? updatedDiff : a.sessionId.localeCompare(b.sessionId)
    })
    return { sessions: flat, groups: [] }
  }

  const accounted = new Set<string>()
  const groups: ThreadListGroup[] = []
  const orderedSessions: SessionView[] = []

  for (const workspace of workspaces) {
    const ids = workspace.sessionIds.filter((id) => {
      accounted.add(id)
      return byId.has(id)
    })
    const sessionIds = sessionOrder(ids, byId, view.orderBy)
    orderedSessions.push(...sessionIds.map((id) => byId.get(id)!))
    groups.push({ key: workspace.workspaceId, workspaceId: workspace.workspaceId, label: workspaceLabel(workspace), path: workspace.path, sessionIds, expanded: view.expandedGroups.includes(workspace.workspaceId) })
  }

  const ungroupedIds = sessions.filter((session) => !session.blank && byId.has(session.sessionId) && !accounted.has(session.sessionId)).map((session) => session.sessionId)
  const ungroupedSessionIds = sessionOrder(ungroupedIds, byId, view.orderBy)
  if (ungroupedSessionIds.length > 0) {
    orderedSessions.push(...ungroupedSessionIds.map((id) => byId.get(id)!))
    groups.push({ key: '', label: 'Ungrouped', sessionIds: ungroupedSessionIds, expanded: view.expandedGroups.includes('') })
  }

  return { sessions: orderedSessions, groups }
}
