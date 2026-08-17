/** zustand store：会话列表、Workspace 分组、当前会话消息与 mux 流状态。 */

import { create } from 'zustand'
import { rpc, respond, type AgentPresetEntry, type AgentPresetListResponse, type CommandEntry, type ContextBreakdownProjection, type ContextPressureProjection, type GoalProjection, type JobView, type ModelCatalogModel, type ModelCatalogResponse, type PendingInteraction, type PermissionSelect, type QueueMessage, type ServerRequest, type SessionAttachment, type SessionModels, type SessionSummary, type WorkspaceListResponse, type WorkspaceView } from './api'
import { foldEvent, foldHistory, type DshMessage } from './messages'

const THREAD_LIST_VIEW_STORAGE_KEY = 'dsh.workspace.view.v1'
const CURRENT_SESSION_STORAGE_KEY = 'dsh.sessions.current'

export type ThreadListGroupBy = 'workspace' | 'flat'
export type ThreadListOrderBy = 'manual' | 'updated'

export interface ThreadListViewState {
  groupBy: ThreadListGroupBy
  orderBy: ThreadListOrderBy
  expandedGroups: string[]
}

export interface SessionView {
  sessionId: string;
  title: string;
  updatedAt: number;
  running: boolean;
  blank: boolean;
  cwd?: string;
  permissions?: PermissionSelect;
  contextUsage?: ContextUsage;
  goal?: GoalProjection | null;
  parentSessionId?: string;
  origin?: 'subagent';
}

export interface ContextUsage {
  system: number
  tools: number
  messages: number
  total: number
}

function contextUsageOf(
  pressure?: ContextPressureProjection,
  breakdown?: ContextBreakdownProjection,
): ContextUsage | undefined {
  const usedTokens = pressure?.projectedTokens ?? pressure?.pressureTokens
  const contextWindow = pressure?.contextWindow
  if (usedTokens === undefined || contextWindow === undefined || contextWindow <= 0) return undefined
  return {
    system: Math.ceil((breakdown?.systemTokens ?? 0) / 1000),
    tools: Math.ceil((breakdown?.toolsTokens ?? 0) / 1000),
    messages: Math.ceil((breakdown?.messageTokens ?? 0) / 1000),
    total: Math.ceil(contextWindow / 1000),
  }
}
function workspaceTitleOf(cwd: string): string {
  return cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? ''
}

function sessionTitleOf(session: SessionSummary): string {
  const projectedTitle = session.projections?.values?.title
  if (typeof session.title === 'string' && session.title.trim()) return session.title
  if (typeof projectedTitle === 'string' && projectedTitle.trim()) return projectedTitle
  if (session.cwd) {
    const workspaceTitle = workspaceTitleOf(session.cwd)
    if (workspaceTitle) return workspaceTitle
  }
  return session.sessionId
}

function readThreadListView(): ThreadListViewState {
  const fallback: ThreadListViewState = { groupBy: 'workspace', orderBy: 'updated', expandedGroups: [] }
  if (typeof window === 'undefined') return fallback
  try {
    const value = JSON.parse(window.localStorage.getItem(THREAD_LIST_VIEW_STORAGE_KEY) ?? '') as Partial<ThreadListViewState>
    return {
      groupBy: value.groupBy === 'flat' ? 'flat' : 'workspace',
      orderBy: value.orderBy === 'manual' ? 'manual' : 'updated',
      expandedGroups: Array.isArray(value.expandedGroups) ? value.expandedGroups.filter((key): key is string => typeof key === 'string') : [],
    }
  } catch {
    return fallback
  }
}

function saveThreadListView(view: ThreadListViewState): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(THREAD_LIST_VIEW_STORAGE_KEY, JSON.stringify(view))
  } catch {
    // Persisting view preferences is best effort.
  }
}

function readCurrentSessionId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    const value = window.localStorage.getItem(CURRENT_SESSION_STORAGE_KEY)
    return value && value.trim() ? value : null
  } catch {
    return null
  }
}

function saveCurrentSessionId(sessionId: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (sessionId) window.localStorage.setItem(CURRENT_SESSION_STORAGE_KEY, sessionId)
    else window.localStorage.removeItem(CURRENT_SESSION_STORAGE_KEY)
  } catch {
    // Persisting the active session is best effort.
  }
}

async function goalRpc(method: string, payload: unknown): Promise<void> {
  const result = await rpc(method, payload)
  if (!result.ok) throw new Error(result.error.message)
}
interface DshState {
  connected: boolean
  host: { version: string; cwd: string; model?: string } | null
  sessions: SessionView[]
  workspaces: WorkspaceView[]
  archivedSessionIds: string[]
  agentPresets: AgentPresetEntry[]
  newSessionWorkspaceId: string | null
  newSessionAgentPreset: string | null
  threadListView: ThreadListViewState
  selectedModel: string | null
  selectedProvider: string | null
  selectedReasoningEffort: string | undefined
  permissions: PermissionSelect | null
  newSessionPermissionPreset: string | null
  modelCatalog: ModelCatalogModel[]
  modelCatalogGroups: { id: string; name: string; models: ModelCatalogModel[] }[]
  modelCatalogLoading: boolean
  currentSessionId: string | null
  goal: GoalProjection | null
  createGoal: (objective: string, maxGoalRounds?: number) => Promise<void>
  editGoal: (objective?: string, maxGoalRounds?: number) => Promise<void>
  pauseGoal: () => Promise<void>
  resumeGoal: () => Promise<void>
  completeGoal: () => Promise<void>
  clearGoal: () => Promise<void>
  contextUsage: ContextUsage | undefined
  queueItems: QueueMessage[]
  queueSessionId: string | null
  jobsBySession: Record<string, JobView[]>
  projectionsBySession: Record<string, Record<string, { value: unknown; seq: number }>>
  commands: CommandEntry[]
  commandsLoading: boolean
  resolveApproval: (approvalId: string) => void
  resolveInteraction: (rpcId: string) => void
  setQueueSnapshot: (sessionId: string, items: QueueMessage[]) => void
  onCancelQueueItem: (itemId: string) => Promise<void>
  onSteerQueueItem: (itemId: string) => Promise<void>
  setJobsSnapshot: (sessionId: string, jobs: JobView[]) => void
  setProjection: (sessionId: string, key: string, value: unknown, seq: number) => void
  messages: DshMessage[]
  isRunning: boolean
  loadingHistory: boolean
  error: string | null
  pendingInteractions: PendingInteraction[]
  boot: () => Promise<void>
  refreshSessions: () => Promise<void>
  openSession: (sessionId: string) => Promise<void>
  createSession: () => Promise<void>
  addWorkspace: () => Promise<void>
  markSessionActive: (sessionId: string) => void
  setNewSessionWorkspace: (workspaceId: string) => void
  setNewSessionAgentPreset: (agentPreset: string) => Promise<void>
  setThreadListGroupBy: (groupBy: ThreadListGroupBy) => void
  setThreadListOrderBy: (orderBy: ThreadListOrderBy) => void
  setThreadListGroupExpanded: (key: string, expanded: boolean) => void
  setModelSelection: (model: string, reasoningEffort?: string) => Promise<void>
  setPermissionPreset: (preset: string) => Promise<void>
  executeCommand: (line: string) => Promise<void>
  loadCommands: (sessionId: string) => Promise<void>
  loadSessionModels: (sessionId: string) => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
  searchSessions: (query: string) => Promise<SessionSummary[]>
  forkSession: (sessionId: string, atSeq?: number) => Promise<void>
  addPendingInteraction: (request: ServerRequest) => void
  respondToInteraction: (rpcId: string, result: { ok: boolean; value?: unknown; error?: unknown }) => Promise<void>
  handleMuxEvent: (sessionId: string, ev: { type: string; seq: number; time: number; data: unknown }) => void
  hydrateMessageImages: (sessionId: string, messages: DshMessage[]) => Promise<DshMessage[]>
  setRunning: (running: boolean) => void
  setConnected: (connected: boolean) => void
}

export const useDsh = create<DshState>((set, get) => ({
  connected: false,
  host: null,
  sessions: [],
  workspaces: [],
  archivedSessionIds: [],
  agentPresets: [],
  newSessionWorkspaceId: null,
  newSessionAgentPreset: null,
  threadListView: readThreadListView(),
  selectedModel: null,
  selectedProvider: null,
  selectedReasoningEffort: undefined,
  permissions: null,
  newSessionPermissionPreset: null,
  modelCatalog: [],
  modelCatalogGroups: [],
  modelCatalogLoading: false,
  currentSessionId: readCurrentSessionId(),
  goal: null,
  contextUsage: undefined,
  queueItems: [],
  queueSessionId: null,
  jobsBySession: {},
  projectionsBySession: {},
  commands: [],
  commandsLoading: false,
  messages: [],
  isRunning: false,
  loadingHistory: false,
  error: null,
  pendingInteractions: [],
  boot: async () => {
    try {
      const result = await rpc<{ version: string; cwd: string; model?: string; provider?: string }>('host.describe')
      if (!result.ok) throw new Error(result.error.message)
      set({ host: result.value, selectedModel: result.value.model ?? null, selectedProvider: result.value.provider ?? null, selectedReasoningEffort: undefined })
      try {
        const catalog = await rpc<ModelCatalogResponse>('llm.models')
        if (catalog.ok) {
          set({
            modelCatalogGroups: catalog.value.groups,
            modelCatalog: catalog.value.groups.flatMap((group) => group.models),
          })
        }
      } catch {
        // Older hosts may not expose global model discovery.
      }
      try {
        const presets = await rpc<AgentPresetListResponse>('agentPreset.list')
        if (presets.ok) set({ agentPresets: presets.value.presets, newSessionAgentPreset: presets.value.presets.find((preset) => preset.isDefault && !preset.broken)?.id ?? null })
      } catch {
        // Older hosts may not expose agent presets.
      }
      await get().refreshSessions()
      const restoredSessionId = get().currentSessionId
      if (restoredSessionId && get().sessions.some((session) => session.sessionId === restoredSessionId)) {
        await get().openSession(restoredSessionId)
      } else if (restoredSessionId) {
        set({ currentSessionId: null, messages: [] })
        saveCurrentSessionId(null)
      }
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  async refreshSessions() {
    const result = await rpc<{ items: SessionSummary[] }>('session.list')
    if (!result.ok) return

    let workspaces: WorkspaceView[] = []
    let archivedSessionIds: string[] = []
    try {
      const workspaceResult = await rpc<WorkspaceListResponse>('workspace.list')
      if (workspaceResult.ok) {
        workspaces = workspaceResult.value.items
        archivedSessionIds = workspaceResult.value.archivedSessionIds ?? []
      }
    } catch {
      // Older hosts may not expose workspace.list; show sessions as Ungrouped.
    }

    set({
      sessions: result.value.items.map((s) => ({
        sessionId: s.sessionId,
        title: sessionTitleOf(s),
        updatedAt: s.updatedAt,
        running: s.running,
        blank: s.blank,
        cwd: s.cwd,
        permissions: s.projections?.values?.permissions,
        contextUsage: contextUsageOf(s.projections?.values?.contextPressure, s.projections?.values?.contextBreakdown),
        goal: s.projections?.values?.goal ?? null,
        parentSessionId: s.parentSessionId,
        origin: s.origin,
      })),
      workspaces,
      archivedSessionIds,
      newSessionWorkspaceId: get().newSessionWorkspaceId ?? workspaces.find((workspace) => workspace.path === get().host?.cwd)?.workspaceId ?? workspaces[0]?.workspaceId ?? null,
      permissions: result.value.items.find((session) => session.sessionId === get().currentSessionId)?.projections?.values?.permissions ?? null,
      newSessionPermissionPreset: result.value.items.find((session) => session.sessionId === get().currentSessionId)?.projections?.values?.permissions?.currentValue ?? get().newSessionPermissionPreset,
      contextUsage: contextUsageOf(
        result.value.items.find((session) => session.sessionId === get().currentSessionId)?.projections?.values?.contextPressure,
        result.value.items.find((session) => session.sessionId === get().currentSessionId)?.projections?.values?.contextBreakdown,
      ),
      goal: result.value.items.find((session) => session.sessionId === get().currentSessionId)?.projections?.values?.goal ?? null,
    })
  },

  async hydrateMessageImages(sessionId, messages) {
    const pending = messages.flatMap((message, messageIndex) => message.parts.flatMap((part, partIndex) =>
      part.type === 'image' && !part.src ? [{ messageIndex, partIndex, part }] : [],
    ))
    if (pending.length === 0) return messages

    const resolved = await Promise.all(pending.map(async ({ part }) => {
      const result = await rpc<SessionAttachment>('session.attachment', {
        sessionId,
        attachmentId: part.attachmentId,
      })
      if (!result.ok) return null
      const mediaType = result.value.attachment?.mediaType ?? part.mediaType ?? 'image/png'
      const data = result.value.data.startsWith('data:')
        ? result.value.data
        : `data:${mediaType};base64,${result.value.data}`
      return { attachmentId: part.attachmentId, src: data, name: result.value.attachment?.name ?? part.name }
    }))
    const next = messages.map((message) => ({ ...message, parts: [...message.parts] }))
    pending.forEach(({ messageIndex, partIndex }, index) => {
      const image = resolved[index]
      const part = next[messageIndex]?.parts[partIndex]
      if (!image || !part || part.type !== 'image') return
      next[messageIndex]!.parts[partIndex] = { ...part, src: image.src, name: image.name }
    })
    return next
  },
  async openSession(sessionId) {
    saveCurrentSessionId(sessionId)
    set({ currentSessionId: sessionId, permissions: get().sessions.find((session) => session.sessionId === sessionId)?.permissions ?? null, contextUsage: get().sessions.find((session) => session.sessionId === sessionId)?.contextUsage, goal: get().sessions.find((session) => session.sessionId === sessionId)?.goal ?? null, messages: [], loadingHistory: true, error: null })
    void get().loadCommands(sessionId)
    try {
      const result = await rpc<{ events: { event: { type: string; seq: number; time: number; data: unknown } }[] }>(
        'session.history',
        { sessionId, maxMessages: 200 },
      )
      if (!result.ok) throw new Error(result.error.message)
      const events = result.value.events.map((e) => e.event)
      const messages = foldHistory(events)
      const hydrated = await get().hydrateMessageImages(sessionId, messages)
      set({ messages: hydrated, loadingHistory: false })
    } catch (error) {
      set({ loadingHistory: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  async createSession() {
    const state = get()
    const workspace = state.workspaces.find((item) => item.workspaceId === state.newSessionWorkspaceId)
    const reusable = state.sessions.find((session) =>
      session.blank &&
      !state.archivedSessionIds.includes(session.sessionId) &&
      (workspace
        ? session.cwd === workspace.path && workspace.sessionIds.includes(session.sessionId)
        : session.cwd === state.host?.cwd),
    )
    if (reusable) {
      await get().openSession(reusable.sessionId)
      return
    }

    const result = await rpc<{ sessionId: string }>('session.create', {
      ...(state.newSessionWorkspaceId ? { workspaceId: state.newSessionWorkspaceId } : {}),
      ...(state.newSessionAgentPreset ? { agentPreset: state.newSessionAgentPreset } : {}),
    })
    if (!result.ok) return
    await get().refreshSessions()
    await get().openSession(result.value.sessionId)
  },

  async addWorkspace() {
    const picked = await rpc<{ path: string | null }>('host.pickDirectory', {})
    if (!picked.ok || !picked.value.path) return

    const created = await rpc<{ workspace: WorkspaceView; created: boolean }>('workspace.create', {
      path: picked.value.path,
    })
    if (!created.ok) {
      set({ error: created.error.message })
      return
    }

    await get().refreshSessions()
    set({ newSessionWorkspaceId: created.value.workspace.workspaceId })
  },

  markSessionActive(sessionId) {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.sessionId === sessionId ? { ...session, blank: false } : session,
      ),
    }))
  },

  setNewSessionWorkspace(workspaceId: string) {
    set({ newSessionWorkspaceId: workspaceId })
  },

  async setNewSessionAgentPreset(agentPreset) {
    set({ newSessionAgentPreset: agentPreset })
    const sessionId = get().currentSessionId
    if (!sessionId) return
    void get().loadCommands(sessionId)
    const result = await rpc<{ agentPreset: string }>('agentPreset.select', { sessionId, agentPreset })
    if (!result.ok) throw new Error(result.error.message)
  },

  async loadCommands(sessionId) {
    set({ commandsLoading: true })
    try {
      const result = await rpc<CommandEntry[]>('commands/list', { args: { agentId: sessionId } })
      if (!result.ok) throw new Error(result.error.message)
      set({ commands: result.value, commandsLoading: false })
    } catch {
      set({ commandsLoading: false, commands: [] })
    }
  },

  async loadSessionModels(sessionId) {
    set({ modelCatalogLoading: true })
    try {
      const result = await rpc<SessionModels>('session.models', { sessionId })
      if (!result.ok) throw new Error(result.error.message)
      const groups = result.value.groups
      const current = result.value.current
      set({
        selectedProvider: current.provider,
        selectedModel: current.model,
        selectedReasoningEffort: current.reasoningEffort,
        modelCatalogGroups: groups,
        modelCatalog: groups.flatMap((group) => group.models),
        modelCatalogLoading: false,
      })
    } catch (error) {
      set({ modelCatalogLoading: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  async setModelSelection(model, reasoningEffort) {
    const provider = get().modelCatalogGroups.find((group) => group.models.some((item) => item.id === model))?.id ?? get().selectedProvider
    const sessionId = get().currentSessionId
    if (!sessionId || !provider) {
      set({ selectedProvider: provider ?? null, selectedModel: model, selectedReasoningEffort: reasoningEffort })
      return
    }
    const result = await rpc<{ selected: { provider: string; model: string; reasoningEffort?: string } }>('session.selectModel', {
      sessionId,
      provider,
      model,
      ...(reasoningEffort ? { reasoningEffort } : {}),
    })
    if (!result.ok) throw new Error(result.error.message)
    set({ selectedProvider: result.value.selected.provider, selectedModel: result.value.selected.model, selectedReasoningEffort: result.value.selected.reasoningEffort })
  },

  async executeCommand(line) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    const result = await rpc('commands/execute', {
      args: { agentId: sessionId, line },
    })
    if (!result.ok) throw new Error(result.error.message)
  },

  async setPermissionPreset(preset) {
    const sessionId = get().currentSessionId
    const permissions = get().permissions
    if (!sessionId) {
      set({
        newSessionPermissionPreset: preset,
        permissions: permissions ? { ...permissions, currentValue: preset } : permissions,
      })
      return
    }
    const result = await rpc<{ result?: unknown }>('commands/execute', {
      args: {
        agentId: sessionId,
        line: `/permission ${preset}`,
      },
    })
    if (!result.ok) throw new Error(result.error.message)
    set({
      newSessionPermissionPreset: preset,
      permissions: permissions ? { ...permissions, currentValue: preset } : permissions,
    })
  },

  async renameSession(sessionId, title) {
    const result = await rpc<{ title: string }>('session.rename', { sessionId, title })
    if (!result.ok) throw new Error(result.error.message)
    set({ sessions: get().sessions.map((session) => session.sessionId === sessionId ? { ...session, title: result.value.title } : session) })
  },

  async searchSessions(query) {
    const result = await rpc<{ items: { sessionId: string; snippet: string }[]; hasMore: boolean }>('session.search', { query })
    if (!result.ok) throw new Error(result.error.message)
    const known = new Map(get().sessions.map((session) => [session.sessionId, session]))
    return result.value.items.map((item) => known.get(item.sessionId) ?? ({
      sessionId: item.sessionId,
      title: item.snippet,
      updatedAt: 0,
      running: false,
      blank: false,
    }))
  },

  async forkSession(sessionId, atSeq) {
    const result = await rpc<{ sessionId: string }>('session.fork', { sessionId, ...(atSeq === undefined ? {} : { atSeq }) })
    if (!result.ok) throw new Error(result.error.message)
    await get().refreshSessions()
    await get().openSession(result.value.sessionId)
  },

  setThreadListGroupBy(groupBy) {
    const view = { ...get().threadListView, groupBy }
    saveThreadListView(view)
    set({ threadListView: view })
  },

  setThreadListOrderBy(orderBy) {
    const view = { ...get().threadListView, orderBy }
    saveThreadListView(view)
    set({ threadListView: view })
  },

  setThreadListGroupExpanded(key, expanded) {
    const current = get().threadListView.expandedGroups
    const expandedGroups = expanded ? [...new Set([...current, key])] : current.filter((item) => item !== key)
    const view = { ...get().threadListView, expandedGroups }
    saveThreadListView(view)
    set({ threadListView: view })
  },

  async createGoal(objective, maxGoalRounds) {
    const sessionId = get().currentSessionId
    if (!sessionId || !objective.trim()) return
    await goalRpc('goals/create', { sessionId, objective: objective.trim(), ...(maxGoalRounds ? { maxGoalRounds } : {}) })
  },

  async editGoal(objective, maxGoalRounds) {
    const sessionId = get().currentSessionId
    const goal = get().goal
    if (!sessionId || !goal) return
    await goalRpc('goals/edit', {
      sessionId,
      ref: { id: goal.goal.id, revision: goal.goal.revision },
      ...(objective === undefined ? {} : { objective: objective.trim() }),
      ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
    })
  },

  async pauseGoal() {
    const sessionId = get().currentSessionId
    const goal = get().goal
    if (sessionId && goal) await goalRpc('goals/pause', { sessionId, ref: { id: goal.goal.id, revision: goal.goal.revision } })
  },

  async resumeGoal() {
    const sessionId = get().currentSessionId
    const goal = get().goal
    if (sessionId && goal) await goalRpc('goals/resume', { sessionId, ref: { id: goal.goal.id, revision: goal.goal.revision } })
  },

  async completeGoal() {
    const sessionId = get().currentSessionId
    const goal = get().goal
    if (sessionId && goal) await goalRpc('goals/complete', { sessionId, ref: { id: goal.goal.id, revision: goal.goal.revision } })
  },

  async clearGoal() {
    const sessionId = get().currentSessionId
    const goal = get().goal
    if (sessionId && goal) await goalRpc('goals/clear', { sessionId, ref: { id: goal.goal.id, revision: goal.goal.revision } })
  },

  resolveApproval(approvalId) {
    set({ pendingInteractions: get().pendingInteractions.filter((item) => item.kind !== 'approval' || (item.payload as { approvalId?: string }).approvalId !== approvalId) })
  },

  resolveInteraction(rpcId) {
    set({ pendingInteractions: get().pendingInteractions.filter((item) => item.rpcId !== rpcId) })
  },

  setJobsSnapshot(sessionId, jobs) {
    set({ jobsBySession: { ...get().jobsBySession, [sessionId]: jobs } })
  },

  setProjection(sessionId, key, value, seq) {
    const current = get().projectionsBySession[sessionId]?.[key]
    if (current && current.seq > seq) return
    if (sessionId === get().currentSessionId && key === 'goal') {
      set({ goal: value as GoalProjection | null })
    }
    set({
      projectionsBySession: {
        ...get().projectionsBySession,
        [sessionId]: {
          ...get().projectionsBySession[sessionId],
          [key]: { value, seq },
        },
      },
    })
  },

  setQueueSnapshot(sessionId, items) {
    set({ queueSessionId: sessionId, queueItems: items })
  },

  async onCancelQueueItem(itemId) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    const result = await rpc('session.updateQueue', { sessionId, itemId, action: { kind: 'remove' } })
    if (!result.ok) throw new Error(result.error.message)
  },

  async onSteerQueueItem(itemId) {
    const sessionId = get().currentSessionId
    if (!sessionId) return
    const result = await rpc('session.updateQueue', { sessionId, itemId, action: { kind: 'steer' } })
    if (!result.ok) throw new Error(result.error.message)
  },

  async respondToInteraction(rpcId, result) {
    await respond(rpcId, result)
    set({ pendingInteractions: get().pendingInteractions.filter((item) => item.rpcId !== rpcId) })
  },

  addPendingInteraction(request) {
    const payload = request.payload as { type?: string; sessionId?: string }
    const kind = payload.type === 'approval/requested' ? 'approval' : payload.type === 'question/requested' ? 'question' : null
    if (!kind || !payload.sessionId) return
    const item: PendingInteraction = { rpcId: request.rpcId, sessionId: payload.sessionId, kind, payload: payload as PendingInteraction['payload'] }
    set({ pendingInteractions: [...get().pendingInteractions.filter((current) => current.rpcId !== request.rpcId), item] })
  },

  handleMuxEvent(sessionId, ev) {
    if (ev.type === 'session/title' || ev.type === 'session/projection' || ev.type === 'permission/preset' || ev.type === 'sandbox/mode' || ev.type === 'approval/policy') {
      void get().refreshSessions().catch(() => {})
    }
    if (sessionId !== get().currentSessionId) return
    const folded = foldEvent(get().messages, ev)
    if (!folded) return
    const patch: Partial<DshState> = { messages: folded.messages }
    if (folded.isRunning !== undefined) patch.isRunning = folded.isRunning
    set(patch as DshState)
    void get().hydrateMessageImages(sessionId, folded.messages).then((messages) => {
      if (get().currentSessionId === sessionId) set({ messages })
    }).catch(() => {})
  },

  setRunning(running) {
    set({ isRunning: running })
  },

  setConnected(connected) {
    set({ connected })
  },
}))
