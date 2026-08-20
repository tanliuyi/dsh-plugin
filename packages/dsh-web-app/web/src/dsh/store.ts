/** zustand store：会话列表、Workspace 分组、当前会话消息与 mux 流状态。 */

import { create } from 'zustand'
import { rpc, respond, type AgentPresetEntry, type AgentPresetListResponse, type CommandEntry, type ContextBreakdownProjection, type ContextPressureProjection, type GoalProjection, type JobView, type ModelCatalogModel, type ProjectionBaseline, type ModelCatalogResponse, type PendingInteraction, type PermissionSelect, type QueueMessage, type QueueMessagePart, type ServerRequest, type SessionAttachment, type SessionModels, type SessionSummary, type SettingsDescribeResponse, type SkillEntry, type SubagentAddress, type SubagentCatalog, type TodoItem, type WorkspaceListResponse, type WorkspaceView } from './api'
import { ConversationFold, type DshMessage, type FoldableSessionEvent } from './messages'
import { KeyedEpochGuard } from './epoch'

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
  todos?: TodoItem[] | null;
  parentSessionId?: string;
  origin?: 'subagent';
  subagentMode?: 'one-shot' | 'continuable';
  subagentLabel?: string;
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

function todoProjectionOf(value: unknown): TodoItem[] | null | undefined {
  if (value === null) return null
  if (!Array.isArray(value)) return undefined
  if (!value.every((item) => {
    if (typeof item !== 'object' || item === null) return false
    const candidate = item as { content?: unknown; status?: unknown }
    return typeof candidate.content === 'string'
      && (candidate.status === 'pending' || candidate.status === 'in_progress' || candidate.status === 'completed')
  })) return undefined
  return value.map((item) => {
    const candidate = item as { content: string; status: TodoItem['status'] }
    return { content: candidate.content, status: candidate.status }
  })
}

function applyTodoEvent(
  value: TodoItem[] | null | undefined,
  event: FoldableSessionEvent,
): { value: TodoItem[] | null | undefined; changed: boolean } {
  if (event.type === 'turn/start') return { value: null, changed: true }
  if (event.type !== 'todo/write') return { value, changed: false }
  const data = (event.data ?? {}) as { todos?: unknown }
  const next = todoProjectionOf(data.todos)
  return next === undefined || next === null
    ? { value, changed: false }
    : { value: next, changed: true }
}

/** Fold todo events after an optional projection watermark. */
export function todosFromEvents(
  events: readonly FoldableSessionEvent[],
  initialValue: TodoItem[] | null | undefined = undefined,
  afterSeq = -1,
): TodoItem[] | null | undefined {
  let value = initialValue
  let determined = initialValue !== undefined
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.seq <= afterSeq) continue
    const next = applyTodoEvent(value, event)
    if (!next.changed) continue
    value = next.value
    determined = true
  }
  return determined ? value : undefined
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
  if (!result.ok) throw new Error(result.error.code ? `${result.error.message} (${result.error.code})` : result.error.message)
}

let openSessionGeneration = 0
let createSessionInFlight: Promise<string | null> | null = null
let bootInFlight: Promise<void> | null = null
const commandLoads = new Map<string, Promise<CommandEntry[]>>()
const skillLoads = new Map<string, Promise<void>>()
/** 每个 session 的目录加载 epoch：只有最新一次发起的请求（含 preset 强刷）才能落盘，旧响应晚返回不得覆盖。 */
const commandEpochs = new KeyedEpochGuard()
const skillEpochs = new KeyedEpochGuard()
const liveEventsDuringOpen = new Map<string, FoldableSessionEvent[]>()
const historyEventsBySession = new Map<string, FoldableSessionEvent[]>()

type PendingLiveRender = {
  sessionId: string
  messages: DshMessage[]
  isRunning?: boolean
}

let pendingLiveRender: PendingLiveRender | null = null
let liveRenderScheduled = false

function scheduleLiveRender(
  next: PendingLiveRender,
  publish: (render: PendingLiveRender) => void,
): void {
  pendingLiveRender = pendingLiveRender?.sessionId === next.sessionId
    ? { ...next, isRunning: next.isRunning ?? pendingLiveRender.isRunning }
    : next
  if (liveRenderScheduled) return
  liveRenderScheduled = true
  const flush = () => {
    liveRenderScheduled = false
    const render = pendingLiveRender
    pendingLiveRender = null
    if (render) publish(render)
  }
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush)
  else queueMicrotask(flush)
}

function mergeSessionEvents(...pages: readonly FoldableSessionEvent[][]): FoldableSessionEvent[] {
  const bySeq = new Map<number, FoldableSessionEvent>()
  for (const page of pages) {
    for (const event of page) bySeq.set(event.seq, event)
  }
  return [...bySeq.values()].sort((left, right) => left.seq - right.seq)
}

/** 每个 session 的状态化 fold（messages + next-step inbox pending/claimed）：
 *  openSession 新建并重放 history、removeSessionState 清理、reopen 重建。 */
const conversationFolds = new Map<string, ConversationFold>()
/** 每个 session 已做过受控 history resync 的 mux generation；防止 subscribed → openSession 循环。 */
const subscribedResyncGeneration = new Map<string, number>()
/** Latest durable mux baseline, kept separate from the locally folded event watermark. */
const subscribedLastSeqBySession = new Map<string, number>()

interface DshState {
  booting: boolean
  connected: boolean
  host: { version: string; cwd: string; model?: string } | null
  sessions: SessionView[]
  workspaces: WorkspaceView[]
  archivedSessionIds: string[]
  agentPresets: AgentPresetEntry[]
  subagentsByParent: Record<string, SubagentCatalog>
  settings: SettingsDescribeResponse | null
  busyEnterBehavior: 'queue' | 'steer'
  setBusyEnterBehavior: (behavior: 'queue' | 'steer') => void
  newSessionWorkspaceId: string | null
  newSessionAgentPreset: string | null
  threadListView: ThreadListViewState
  selectedModel: string | null
  selectedProvider: string | null
  selectedReasoningEffort: string | undefined
  modelRoutable: boolean | null
  modelCatalogSessionId: string | null
  permissions: PermissionSelect | null
  newSessionPermissionPreset: string | null
  modelCatalog: ModelCatalogModel[]
  modelCatalogGroups: { id: string; name: string; models: ModelCatalogModel[] }[]
  modelCatalogLoading: boolean
  currentSessionId: string | null
  goal: GoalProjection | null
  /** Host projection: undefined before capability data, null after turn/start. */
  todos: TodoItem[] | null | undefined
  planMode: boolean
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
  commandsSessionId: string | null
  commandsLoading: boolean
  commandLoadError: string | null
  skills: SkillEntry[]
  skillsSessionId: string | null
  skillsLoading: boolean
  loadSkills: (sessionId: string, refresh?: boolean) => Promise<void>
  resolveApproval: (approvalId: string) => void
  resolveInteraction: (rpcId: string) => void
  setQueueSnapshot: (sessionId: string, items: QueueMessage[]) => void
  onCancelQueueItem: (itemId: string) => Promise<void>
  onSteerQueueItem: (itemId: string) => Promise<void>
  setJobsSnapshot: (sessionId: string, jobs: JobView[]) => void
  setSessionRunning: (sessionId: string, running: boolean) => void
  removeSessionState: (sessionId: string) => void
  setProjection: (sessionId: string, key: string, value: unknown, seq: number) => void
  truncateProjections: (sessionId: string, lastSeq: number) => void
  messages: DshMessage[]
  lastEventSeqBySession: Record<string, number>
  isRunning: boolean
  loadingHistory: boolean
  loadingMoreHistory: boolean
  historyHasMore: boolean
  historyLoadError: string | null
  loadMoreHistory: () => Promise<void>
  error: string | null
  pendingInteractions: PendingInteraction[]
  boot: (preferredSessionId?: string) => Promise<void>
  refreshSessions: () => Promise<void>
  openSession: (sessionId: string) => Promise<void>
  createSession: (forceNew?: boolean) => Promise<string | null>
  addWorkspace: () => Promise<void>
  renameWorkspace: (workspaceId: string, title: string) => Promise<void>
  deleteWorkspace: (workspaceId: string) => Promise<void>
  applyHostWorkspaceChanged: (workspace: WorkspaceView) => void
  applyHostWorkspaceRemoved: (workspaceId: string) => void
  applyHostWorkspaceOrder: (workspaceIds: string[]) => void
  markSessionActive: (sessionId: string) => void
  setNewSessionWorkspace: (workspaceId: string) => void
  setNewSessionAgentPreset: (agentPreset: string) => Promise<void>
  setThreadListGroupBy: (groupBy: ThreadListGroupBy) => void
  setThreadListOrderBy: (orderBy: ThreadListOrderBy) => void
  setThreadListGroupExpanded: (key: string, expanded: boolean) => void
  setModelSelection: (provider: string, model: string, reasoningEffort?: string) => Promise<void>
  setPermissionPreset: (preset: string) => Promise<void>
  executeCommand: (line: string, sessionId?: string) => Promise<void>
  loadCommands: (sessionId: string, refresh?: boolean) => Promise<CommandEntry[]>
  loadSessionModels: (sessionId: string) => Promise<void>
  renameSession: (sessionId: string, title: string) => Promise<void>
  searchSessions: (query: string) => Promise<SessionSummary[]>
  forkSession: (sessionId: string, atSeq?: number) => Promise<void>
  loadSubagents: (parentSessionId: string) => Promise<void>
  addPendingInteraction: (request: ServerRequest) => void
  respondToInteraction: (rpcId: string, result: { ok: boolean; value?: unknown; error?: unknown }) => Promise<void>
  handleMuxEvent: (sessionId: string, ev: FoldableSessionEvent) => void
  handleSubscribed: (sessionId: string, lastSeq: number, streamGeneration: number) => void
  hydrateMessageImages: (sessionId: string, messages: DshMessage[]) => Promise<DshMessage[]>
  setRunning: (running: boolean) => void
  setConnected: (connected: boolean) => void
}

export const useDsh = create<DshState>((set, get) => ({
  booting: true,
  connected: false,
  host: null,
  sessions: [],
  workspaces: [],
  archivedSessionIds: [],
  agentPresets: [],
  subagentsByParent: {},
  settings: null,
  busyEnterBehavior: 'queue',
  setBusyEnterBehavior: (busyEnterBehavior) => set({ busyEnterBehavior }),
  newSessionWorkspaceId: null,
  newSessionAgentPreset: null,
  threadListView: readThreadListView(),
  selectedModel: null,
  selectedProvider: null,
  selectedReasoningEffort: undefined,
  modelRoutable: null,
  modelCatalogSessionId: null,
  permissions: null,
  newSessionPermissionPreset: null,
  modelCatalog: [],
  modelCatalogGroups: [],
  modelCatalogLoading: false,
  currentSessionId: readCurrentSessionId(),
  goal: null,
  todos: undefined,
  planMode: false,
  contextUsage: undefined,
  queueItems: [],
  queueSessionId: null,
  jobsBySession: {},
  projectionsBySession: {},
  commands: [],
  commandsSessionId: null,
  commandsLoading: false,
  commandLoadError: null,
  skills: [],
  skillsSessionId: null,
  skillsLoading: false,
  messages: [],
  lastEventSeqBySession: {},
  isRunning: false,
  loadingHistory: false,
  loadingMoreHistory: false,
  historyHasMore: false,
  historyLoadError: null,
  error: null,
  pendingInteractions: [],
  boot: async (preferredSessionId) => {
    if (bootInFlight) return bootInFlight
    const operation = (async () => {
      try {
        const result = await rpc<{ version: string; cwd: string; model?: string; provider?: string }>('host.describe')
        if (!result.ok) throw new Error(result.error.message)
        set({ host: result.value, selectedModel: result.value.model ?? null, selectedProvider: result.value.provider ?? null, selectedReasoningEffort: undefined, modelRoutable: null, modelCatalogSessionId: null })
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
        try {
          const settings = await rpc<SettingsDescribeResponse>('settings.describe')
          if (settings.ok) {
            const conversation = settings.value.namespaces.find((entry) => entry.ns === 'ui-conversation')?.value
            const busyEnter = typeof conversation === 'object' && conversation !== null
              ? (conversation as { busyEnter?: unknown }).busyEnter
              : undefined
            set({
              settings: settings.value,
              busyEnterBehavior: busyEnter === 'steer' ? 'steer' : 'queue',
            })
          }
        } catch {
          // Remote or older hosts may not expose settings.describe.
        }
        await get().refreshSessions()
        const restoredSessionId = get().currentSessionId
        const preferred = preferredSessionId && get().sessions.some((session) => session.sessionId === preferredSessionId)
          ? preferredSessionId
          : null
        const initialSessionId = preferred ?? restoredSessionId
        if (initialSessionId && get().sessions.some((session) => session.sessionId === initialSessionId)) {
          await get().openSession(initialSessionId)
        } else {
          // 无有效 restored id：先清掉陈旧/缺失的 id，再复用当前 workspace 的 blank session
          // （上游 blank composer 已绑定可复用 blank session），否则新建并 open。
          if (restoredSessionId) {
            set({ currentSessionId: null, messages: [] })
            saveCurrentSessionId(null)
          }
          await get().createSession(false)
        }
      } catch (error) {
        set({ error: error instanceof Error ? error.message : String(error) })
      } finally {
        set({ booting: false })
      }
    })()
    bootInFlight = operation
    try {
      await operation
    } finally {
      if (bootInFlight === operation) bootInFlight = null
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
        todos: todoProjectionOf(s.projections?.values?.todos),
        parentSessionId: s.parentSessionId,
        origin: s.origin,
        subagentMode: (() => {
          const projection = s.projections?.values?.subagent as { mode?: unknown } | undefined
          return projection?.mode === 'one-shot' || projection?.mode === 'continuable'
            ? projection.mode
            : undefined
        })(),
        subagentLabel: (() => {
          const projection = s.projections?.values?.subagent as { label?: unknown } | undefined
          return typeof projection?.label === 'string' ? projection.label : undefined
        })(),
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
      todos: todoProjectionOf(result.value.items.find((session) => session.sessionId === get().currentSessionId)?.projections?.values?.todos),
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
    const generation = ++openSessionGeneration
    liveEventsDuringOpen.set(sessionId, [])
    // 新的状态化 fold：重放 history 会重建 next-step pending/claimed（steering 判定）。
    const folder = new ConversationFold()
    conversationFolds.set(sessionId, folder)
    saveCurrentSessionId(sessionId)
    const session = get().sessions.find((item) => item.sessionId === sessionId)
    const isSubagent = session?.origin === 'subagent'
    set({ currentSessionId: sessionId, permissions: session?.permissions ?? null, contextUsage: session?.contextUsage, goal: session?.goal ?? null, todos: session?.todos, messages: [], loadingHistory: true, loadingMoreHistory: false, historyHasMore: false, historyLoadError: null, error: null, isRunning: session?.running ?? false, planMode: false, modelCatalogGroups: [], modelCatalog: [], modelCatalogLoading: !isSubagent, selectedProvider: null, selectedModel: null, selectedReasoningEffort: undefined, modelRoutable: null, modelCatalogSessionId: null, commands: [], commandsSessionId: null, commandsLoading: !isSubagent, commandLoadError: null, skills: [], skillsSessionId: null, skillsLoading: !isSubagent })
    if (!isSubagent) {
      void get().loadCommands(sessionId).catch(() => {})
      void get().loadSkills(sessionId)
      void get().loadSessionModels(sessionId)
    } else if (session.parentSessionId) {
      void get().loadSubagents(session.parentSessionId)
    }
    try {
      let result: Awaited<ReturnType<typeof rpc<{ events: { event: FoldableSessionEvent }[]; projections?: ProjectionBaseline; hasMore?: boolean }>>>
      if (session?.origin === 'subagent' && session.parentSessionId) {
        const catalogResult = await rpc<SubagentCatalog>('subagent.list', { parentSessionId: session.parentSessionId })
        if (generation !== openSessionGeneration || get().currentSessionId !== sessionId) return
        const entry = catalogResult.ok
          ? catalogResult.value.entries.find((item) => item.kind === 'child' && item.id === sessionId)
          : undefined
        const mode = entry?.kind === 'child' ? entry.mode : session.subagentMode ?? 'one-shot'
        if (entry?.kind === 'child') {
          set((state) => ({
            sessions: state.sessions.map((item) => item.sessionId === sessionId
              ? { ...item, subagentMode: entry.mode, subagentLabel: entry.label ?? item.subagentLabel }
              : item),
          }))
        }
        result = await rpc<{ events: { event: FoldableSessionEvent }[]; projections?: ProjectionBaseline; hasMore?: boolean }>('subagent.history', {
          parentSessionId: session.parentSessionId,
          childSessionId: sessionId,
          mode,
          maxMessages: 200,
        })
      } else {
        result = await rpc<{ events: { event: FoldableSessionEvent }[]; projections?: ProjectionBaseline; hasMore?: boolean }>(
          'session.history',
          { sessionId, maxMessages: 200 },
        )
      }
      if (!result.ok) throw new Error(result.error.message)
      if (generation !== openSessionGeneration || get().currentSessionId !== sessionId) return

      // The subscribed frame is the durable tail at connection time. History can
      // race an event append and return an older tail, so mirror upstream's one
      // tail-page repull before publishing an incomplete command lifecycle.
      const subscribedLastSeq = subscribedLastSeqBySession.get(sessionId)
      const historyTailSeq = result.value.events.at(-1)?.event.seq ?? -1
      if (subscribedLastSeq !== undefined && subscribedLastSeq > historyTailSeq) {
        result = session?.origin === 'subagent' && session.parentSessionId
          ? await rpc('subagent.history', {
              parentSessionId: session.parentSessionId,
              childSessionId: sessionId,
              mode: session.subagentMode ?? 'one-shot',
              maxMessages: 200,
            })
          : await rpc('session.history', { sessionId, maxMessages: 200 })
        if (!result.ok) throw new Error(result.error.message)
        if (generation !== openSessionGeneration || get().currentSessionId !== sessionId) return
      }

      const values = result.value.projections?.values
      const projectionGoal = values?.goal as GoalProjection | null | undefined
      const projectionPlan = values?.plan as { active?: unknown; pending?: unknown } | undefined
      const baseline = result.value.projections
      const hasTodoProjection = values !== undefined && Object.prototype.hasOwnProperty.call(values, 'todos')
      if (baseline) {
        const rows = Object.fromEntries(Object.entries(baseline.values).map(([key, value]) => [key, { value, seq: baseline.asOfSeq }]))
        set({ projectionsBySession: { ...get().projectionsBySession, [sessionId]: rows } })
      }
      if (projectionGoal !== undefined || projectionPlan !== undefined || hasTodoProjection) {
        set({
          ...(projectionGoal !== undefined ? { goal: projectionGoal } : {}),
          ...(projectionPlan !== undefined ? { planMode: projectionPlan.pending === true ? projectionPlan.active !== true : projectionPlan.active === true } : {}),
          ...(hasTodoProjection ? { todos: todoProjectionOf(values?.todos) ?? null } : {}),
        })
      }
      const historyEvents = result.value.events.map((e) => e.event)
      historyEventsBySession.set(sessionId, historyEvents)
      const baselineTodos = hasTodoProjection ? todoProjectionOf(values?.todos) ?? null : undefined
      const eventTodos = hasTodoProjection
        ? todosFromEvents(historyEvents, baselineTodos, baseline?.asOfSeq ?? -1)
        : todosFromEvents(historyEvents)
      let currentTodos = hasTodoProjection
        ? eventTodos ?? baselineTodos ?? null
        : eventTodos === undefined ? session?.todos : eventTodos
      const todoWatermark = hasTodoProjection ? baseline?.asOfSeq ?? -1 : -1
      // 状态化重放 history（含 agent/inbox/spliced → 重建 pending/claimed）。
      for (const event of historyEvents) folder.fold(event)
      let merged = folder.getMessages()
      // 把 open 期间缓冲的 live 事件按 seq 折入同一 fold：folder 按 seq 去重，
      // history + live 共用一份状态，steering 判定一致。hydration 是唯一 await，
      // 期间新到的 live 事件会被继续折入，直到一轮 hydration 后 buffer 为空。
      for (;;) {
        const buffered = liveEventsDuringOpen.get(sessionId) ?? []
        let added = false
        if (buffered.length > 0) {
          historyEventsBySession.set(sessionId, mergeSessionEvents(historyEventsBySession.get(sessionId) ?? [], buffered))
        }
        for (const event of [...buffered].sort((left, right) => left.seq - right.seq)) {
          if (event.seq > todoWatermark) {
            const todo = applyTodoEvent(currentTodos, event)
            if (todo.changed) currentTodos = todo.value
          }
          if (folder.fold(event) !== null) added = true
        }
        if (buffered.length > 0) liveEventsDuringOpen.set(sessionId, [])
        merged = await get().hydrateMessageImages(sessionId, folder.getMessages())
        if (generation !== openSessionGeneration || get().currentSessionId !== sessionId) return
        if ((liveEventsDuringOpen.get(sessionId) ?? []).length === 0) break
      }
      folder.applyMessages(merged)
      if (generation !== openSessionGeneration || get().currentSessionId !== sessionId) return
      liveEventsDuringOpen.delete(sessionId)
      const lastSeq = folder.lastSeq
      set({
        messages: merged,
        todos: currentTodos,
        loadingHistory: false,
        historyHasMore: result.value.hasMore === true,
        historyLoadError: null,
        lastEventSeqBySession: { ...get().lastEventSeqBySession, [sessionId]: lastSeq },
      })
    } catch (error) {
      if (generation !== openSessionGeneration || get().currentSessionId !== sessionId) return
      liveEventsDuringOpen.delete(sessionId)
      set({ loadingHistory: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  async loadMoreHistory() {
    const state = get()
    const sessionId = state.currentSessionId
    if (!sessionId || state.loadingHistory || state.loadingMoreHistory || !state.historyHasMore) return
    const loaded = historyEventsBySession.get(sessionId) ?? []
    const beforeSeq = loaded[0]?.seq
    if (beforeSeq === undefined) return
    const session = state.sessions.find((item) => item.sessionId === sessionId)
    set({ loadingMoreHistory: true, historyLoadError: null })
    try {
      let result: Awaited<ReturnType<typeof rpc<{ events: { event: FoldableSessionEvent }[]; hasMore?: boolean }>>>
      if (session?.origin === 'subagent' && session.parentSessionId) {
        result = await rpc('subagent.history', {
          parentSessionId: session.parentSessionId,
          childSessionId: sessionId,
          mode: session.subagentMode ?? 'one-shot',
          beforeSeq,
          maxMessages: 100,
        })
      } else {
        result = await rpc('session.history', { sessionId, beforeSeq, maxMessages: 100 })
      }
      if (!result.ok) throw new Error(result.error.message)
      if (get().currentSessionId !== sessionId) return
      const currentEvents = historyEventsBySession.get(sessionId) ?? []
      const mergedEvents = mergeSessionEvents(result.value.events.map((item) => item.event), currentEvents)
      historyEventsBySession.set(sessionId, mergedEvents)
      const folder = new ConversationFold()
      for (const event of mergedEvents) folder.fold(event)
      const messages = await get().hydrateMessageImages(sessionId, folder.getMessages())
      if (get().currentSessionId !== sessionId) return
      folder.applyMessages(messages)
      conversationFolds.set(sessionId, folder)
      set({
        messages,
        loadingMoreHistory: false,
        historyHasMore: result.value.hasMore === true,
        historyLoadError: null,
      })
    } catch (error) {
      if (get().currentSessionId === sessionId) {
        set({
          loadingMoreHistory: false,
          historyLoadError: error instanceof Error ? error.message : String(error),
        })
      }
    }
  },

  async createSession(forceNew = false) {
    if (createSessionInFlight) return createSessionInFlight

    const operation = (async (): Promise<string | null> => {
      const state = get()
      const workspace = state.workspaces.find((item) => item.workspaceId === state.newSessionWorkspaceId)
      const reusable = forceNew ? undefined : state.sessions.find((session) =>
        session.blank &&
        !state.archivedSessionIds.includes(session.sessionId) &&
        (workspace
          ? session.cwd === workspace.path && workspace.sessionIds.includes(session.sessionId)
          : session.cwd === state.host?.cwd),
      )
      if (reusable) {
        await get().openSession(reusable.sessionId)
        return reusable.sessionId
      }

      const result = await rpc<{ sessionId: string }>('session.create', {
        ...(state.newSessionWorkspaceId ? { workspaceId: state.newSessionWorkspaceId } : {}),
        ...(state.newSessionAgentPreset ? { agentPreset: state.newSessionAgentPreset } : {}),
      })
      if (!result.ok) return null
      await get().refreshSessions()
      await get().openSession(result.value.sessionId)
      return result.value.sessionId
    })()
    createSessionInFlight = operation
    try {
      return await operation
    } finally {
      if (createSessionInFlight === operation) createSessionInFlight = null
    }
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

  async renameWorkspace(workspaceId, title) {
    const result = await rpc<{ workspace: WorkspaceView }>('workspace.rename', { workspaceId, title: title.trim() })
    if (!result.ok) throw new Error(result.error.message)
    set((state) => ({ workspaces: state.workspaces.map((workspace) => workspace.workspaceId === workspaceId ? result.value.workspace : workspace) }))
  },

  async deleteWorkspace(workspaceId) {
    const result = await rpc<{ deleted: true }>('workspace.delete', { workspaceId })
    if (!result.ok) throw new Error(result.error.message)
    await get().refreshSessions()
  },

  // host/workspace-changed：注册表一次变更后的完整新快照，客户端原地 upsert。
  applyHostWorkspaceChanged(workspace) {
    set((state) => {
      const exists = state.workspaces.some((w) => w.workspaceId === workspace.workspaceId)
      return {
        workspaces: exists
          ? state.workspaces.map((w) => (w.workspaceId === workspace.workspaceId ? workspace : w))
          : [...state.workspaces, workspace],
      }
    })
  },

  // host/workspace-removed：注册表删除的提交增量（不删除目录/session 日志）。
  applyHostWorkspaceRemoved(workspaceId) {
    set((state) => ({
      workspaces: state.workspaces.filter((w) => w.workspaceId !== workspaceId),
      ...(state.newSessionWorkspaceId === workspaceId ? { newSessionWorkspaceId: null } : {}),
    }))
  },

  // host/workspace-order-changed：持久注册表顺序，未知项保持原位置追加。
  applyHostWorkspaceOrder(workspaceIds) {
    set((state) => {
      const byId = new Map(state.workspaces.map((w) => [w.workspaceId, w]))
      const ordered = workspaceIds.flatMap((id) => {
        const found = byId.get(id)
        return found ? [found] : []
      })
      const rest = state.workspaces.filter((w) => !workspaceIds.includes(w.workspaceId))
      return { workspaces: [...ordered, ...rest] }
    })
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
    const result = await rpc<{ agentPreset: string }>('agentPreset.select', { sessionId, agentPreset })
    if (!result.ok) throw new Error(result.error.message)
    // preset 选择后强刷命令目录与 skills：绕过各自「已就绪」缓存，反映新 preset 的目录。
    await Promise.all([
      get().loadCommands(sessionId, true),
      get().loadSkills(sessionId, true),
    ])
  },

  async loadCommands(sessionId, refresh = false) {
    if (!refresh) {
      const existing = commandLoads.get(sessionId)
      if (existing) {
        try {
          return await existing
        } catch {
          // op 自身已记录错误并返回缓存；这里不应再向外抛。
          return get().commands
        }
      }
      if (get().commandsSessionId === sessionId && get().commandLoadError === null) return get().commands
    }

    if (get().currentSessionId === sessionId) set({ commandsLoading: true, commandLoadError: null })
    const epoch = commandEpochs.begin(sessionId)
    const inFlight: { current?: Promise<CommandEntry[]> } = {}
    const operation = (async (): Promise<CommandEntry[]> => {
      try {
        const result = await rpc<CommandEntry[]>('commands/list', { args: { agentId: sessionId } })
        if (!result.ok) throw new Error(`command.list failed: ${result.error.code}: ${result.error.message}`)
        if (get().currentSessionId === sessionId && commandEpochs.isCurrent(sessionId, epoch)) {
          set({ commands: result.value, commandsSessionId: sessionId, commandsLoading: false, commandLoadError: null })
        }
        return result.value
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause)
        if (get().currentSessionId === sessionId && commandEpochs.isCurrent(sessionId, epoch)) {
          // 目录故障：保留最后一次成功缓存（用于证明 host command），仅标记错误，
          // 不抛——让运行时把「可证明命令」报错保留输入、把 skill/unknown 放行 prompt。
          set({ commandsSessionId: sessionId, commandsLoading: false, commandLoadError: message })
        }
        return get().commands
      } finally {
        if (commandLoads.get(sessionId) === inFlight.current) commandLoads.delete(sessionId)
      }
    })()
    inFlight.current = operation
    commandLoads.set(sessionId, operation)
    return operation
  },

  async loadSkills(sessionId, refresh = false) {
    if (!refresh) {
      const inFlight = skillLoads.get(sessionId)
      if (inFlight) return inFlight
    }
    // 当前 session 守卫：响应只应用到发起时的 session（A/B 切换不串）。
    if (get().currentSessionId === sessionId) set({ skillsLoading: true })
    const epoch = skillEpochs.begin(sessionId)
    const opSlot: { current?: Promise<void> } = {}
    const operation = (async () => {
      try {
        // 上游 skills.list：只读目录，{ sessionId } 寻址（宿主导出规范项目根，客户端不传路径）。
        const result = await rpc<{ skills: SkillEntry[] }>('skill.list', { sessionId })
        if (!result.ok) throw new Error(result.error.message)
        if (get().currentSessionId === sessionId && skillEpochs.isCurrent(sessionId, epoch)) {
          set({ skills: result.value.skills, skillsSessionId: sessionId, skillsLoading: false })
        }
      } catch {
        if (get().currentSessionId === sessionId && skillEpochs.isCurrent(sessionId, epoch)) {
          set({ skillsLoading: false, skillsSessionId: sessionId, skills: [] })
        }
      } finally {
        if (skillLoads.get(sessionId) === opSlot.current) skillLoads.delete(sessionId)
      }
    })()
    opSlot.current = operation
    skillLoads.set(sessionId, operation)
    return operation
  },

  async loadSessionModels(sessionId) {
    const generation = openSessionGeneration
    set({ modelCatalogLoading: true })
    try {
      const result = await rpc<SessionModels>('session.models', { sessionId })
      if (generation !== openSessionGeneration || get().currentSessionId !== sessionId) return
      if (!result.ok) throw new Error(result.error.message)
      const groups = result.value.groups
      const current = result.value.current
      set({
        selectedProvider: current.provider,
        selectedModel: current.model,
        selectedReasoningEffort: current.reasoningEffort,
        modelRoutable: result.value.routable,
        modelCatalogSessionId: sessionId,
        modelCatalogGroups: groups,
        modelCatalog: groups.flatMap((group) => group.models),
        modelCatalogLoading: false,
      })
    } catch (error) {
      if (generation !== openSessionGeneration || get().currentSessionId !== sessionId) return
      set({ modelCatalogLoading: false, modelRoutable: null, modelCatalogSessionId: sessionId, error: error instanceof Error ? error.message : String(error) })
    }
  },

  async setModelSelection(provider, model, reasoningEffort) {
    const sessionId = get().currentSessionId
    if (!sessionId || !provider) {
      set({ selectedProvider: provider || null, selectedModel: model, selectedReasoningEffort: reasoningEffort })
      return
    }
    const result = await rpc<{ selected: { provider: string; model: string; reasoningEffort?: string } }>('session.selectModel', {
      sessionId,
      provider,
      model,
      ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
    })
    if (!result.ok) throw new Error(result.error.message)
    set({ selectedProvider: result.value.selected.provider, selectedModel: result.value.selected.model, selectedReasoningEffort: result.value.selected.reasoningEffort, modelRoutable: true })
  },

  async executeCommand(line, addressedSessionId) {
    const sessionId = addressedSessionId ?? get().currentSessionId
    if (!sessionId) throw new Error('command.execute requires a session')
    const result = await rpc<{ commandId: string; result: { kind: 'success' | 'error'; text?: string } } | undefined>('commands/execute', {
      args: { agentId: sessionId, line, images: [] },
    })
    if (!result.ok) throw new Error(`command.execute failed: ${result.error.code}: ${result.error.message}`)
    if (result.value === undefined) throw new Error(`unknown or malformed command: ${line}`)
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
        images: [],
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

  async loadSubagents(parentSessionId) {
    const result = await rpc<SubagentCatalog>('subagent.list', { parentSessionId })
    if (!result.ok) throw new Error(result.error.message)
    const entriesById = new Map(result.value.entries.flatMap((entry) =>
      entry.kind === 'child' ? [[entry.id, entry] as const] : [],
    ))
    set((state) => ({
      subagentsByParent: { ...state.subagentsByParent, [parentSessionId]: result.value },
      sessions: state.sessions.map((session) => {
        if (session.parentSessionId !== parentSessionId) return session
        const entry = entriesById.get(session.sessionId)
        return entry
          ? { ...session, subagentMode: entry.mode, subagentLabel: entry.label ?? session.subagentLabel }
          : session
      }),
    }))
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
    await goalRpc('goal.create', { sessionId, objective: objective.trim(), ...(maxGoalRounds ? { maxGoalRounds } : {}) })
  },

  async editGoal(objective, maxGoalRounds) {
    const sessionId = get().currentSessionId
    const goal = get().goal
    if (!sessionId || !goal) return
    await goalRpc('goal.edit', {
      sessionId,
      ref: { id: goal.goal.id, revision: goal.goal.revision },
      ...(objective === undefined ? {} : { objective: objective.trim() }),
      ...(maxGoalRounds === undefined ? {} : { maxGoalRounds }),
    })
  },

  async pauseGoal() {
    const sessionId = get().currentSessionId
    const goal = get().goal
    if (sessionId && goal) await goalRpc('goal.pause', { sessionId, ref: { id: goal.goal.id, revision: goal.goal.revision } })
  },

  async resumeGoal() {
    const sessionId = get().currentSessionId
    const goal = get().goal
    if (sessionId && goal) await goalRpc('goal.resume', { sessionId, ref: { id: goal.goal.id, revision: goal.goal.revision } })
  },

  async completeGoal() {
    const sessionId = get().currentSessionId
    const goal = get().goal
    if (sessionId && goal) await goalRpc('goal.complete', { sessionId, ref: { id: goal.goal.id, revision: goal.goal.revision } })
  },

  async clearGoal() {
    const sessionId = get().currentSessionId
    const goal = get().goal
    if (sessionId && goal) await goalRpc('goal.clear', { sessionId, ref: { id: goal.goal.id, revision: goal.goal.revision } })
  },

  resolveApproval(approvalId) {
    set({ pendingInteractions: get().pendingInteractions.filter((item) => item.kind !== 'approval' || (item.payload as { approvalId?: string }).approvalId !== approvalId) })
  },

  resolveInteraction(rpcId) {
    set({ pendingInteractions: get().pendingInteractions.filter((item) => item.rpcId !== rpcId) })
  },

  setJobsSnapshot(sessionId, jobs) {
    const jobsBySession = { ...get().jobsBySession }
    if (jobs.length > 0) jobsBySession[sessionId] = jobs
    else delete jobsBySession[sessionId]
    set({ jobsBySession })
  },

  setSessionRunning(sessionId, running) {
    set((state) => ({ sessions: state.sessions.map((session) => session.sessionId === sessionId ? { ...session, running } : session), ...(state.currentSessionId === sessionId ? { isRunning: running } : {}) }))
  },

  removeSessionState(sessionId) {
    const state = get()
    const jobsBySession = { ...state.jobsBySession }
    const projectionsBySession = { ...state.projectionsBySession }
    const lastEventSeqBySession = { ...state.lastEventSeqBySession }
    delete jobsBySession[sessionId]
    delete projectionsBySession[sessionId]
    delete lastEventSeqBySession[sessionId]
    liveEventsDuringOpen.delete(sessionId)
    historyEventsBySession.delete(sessionId)
    conversationFolds.delete(sessionId)
    subscribedLastSeqBySession.delete(sessionId)
    subscribedResyncGeneration.delete(sessionId)
    set({
      sessions: state.sessions.filter((session) => session.sessionId !== sessionId),
      jobsBySession,
      projectionsBySession,
      lastEventSeqBySession,
      pendingInteractions: state.pendingInteractions.filter((item) => item.sessionId !== sessionId),
      ...(state.queueSessionId === sessionId ? { queueSessionId: null, queueItems: [] } : {}),
      ...(state.currentSessionId === sessionId ? { currentSessionId: null, messages: [], goal: null, todos: undefined, contextUsage: undefined, permissions: null, isRunning: false } : {}),
    })
  },

  setProjection(sessionId, key, value, seq) {
    const current = get().projectionsBySession[sessionId]?.[key]
    if (current && current.seq >= seq) return
    if (sessionId === get().currentSessionId && key === 'goal') {
      set({ goal: value as GoalProjection | null })
    }
    if (sessionId === get().currentSessionId && key === 'plan') {
      const plan = value as { active?: unknown; pending?: unknown } | null
      set({ planMode: plan?.pending === true ? plan.active !== true : plan?.active === true })
    }
    if (sessionId === get().currentSessionId && key === 'todos') {
      set({ todos: todoProjectionOf(value) ?? null })
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

  truncateProjections(sessionId, lastSeq) {
    const session = get().projectionsBySession[sessionId]
    if (!session) return
    const next = Object.fromEntries(Object.entries(session).filter(([, row]) => row.seq <= lastSeq))
    set({ projectionsBySession: { ...get().projectionsBySession, [sessionId]: next } })
  },

  setQueueSnapshot(sessionId, items) {
    set({ queueSessionId: sessionId, queueItems: items })
    const withPendingImages = items.filter((item) =>
      item.parts.some((part) => part.type === 'image' && !part.src),
    )
    if (withPendingImages.length === 0) return

    const projected = withPendingImages.map((item, index): DshMessage => ({
      id: item.id,
      role: 'user',
      parts: item.parts,
      seq: index,
    }))
    void get().hydrateMessageImages(sessionId, projected).then((hydrated) => {
      if (get().queueSessionId !== sessionId) return
      const sourceById = new Map(withPendingImages.map((item) => [item.id, item]))
      const hydratedById = new Map(hydrated.map((message) => [message.id, message]))
      set((state) => ({
        queueItems: state.queueItems.map((item) => {
          const source = sourceById.get(item.id)
          const message = hydratedById.get(item.id)
          if (!source || !message || source.messageId !== item.messageId) return item
          const parts = message.parts.filter(
            (part): part is QueueMessagePart => part.type === 'text' || part.type === 'image',
          )
          return { ...item, parts }
        }),
      }))
    }).catch(() => {})
  },

  async onCancelQueueItem(itemId) {
    const sessionId = get().queueSessionId
    if (!sessionId || sessionId !== get().currentSessionId) return
    const result = await rpc('session.updateQueue', { sessionId, itemId, action: { kind: 'remove' } })
    if (!result.ok) throw new Error(result.error.message)
  },

  async onSteerQueueItem(itemId) {
    const sessionId = get().queueSessionId
    if (!sessionId || sessionId !== get().currentSessionId) return
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
    // Session logs are zero-based. An unseen session therefore starts at -1;
    // using 0 here silently drops its first live event.
    const lastSeq = get().lastEventSeqBySession[sessionId] ?? -1
    if (ev.seq <= lastSeq) return
    set({ lastEventSeqBySession: { ...get().lastEventSeqBySession, [sessionId]: ev.seq } })
    const todo = applyTodoEvent(get().todos, ev)
    if (todo.changed) set({ todos: todo.value })
    // openSession 装载中：事件先进 live buffer，装载完成后由 openSession 按 seq
    // 折入同一个 ConversationFold（避免与 history 重放竞争、丢失 steering 依赖的
    // inbox 事件）。
    const opening = liveEventsDuringOpen.get(sessionId)
    if (opening) {
      opening.push(ev)
      return
    }
    const folder = conversationFolds.get(sessionId)
    if (!folder) return
    const historyEvents = historyEventsBySession.get(sessionId) ?? []
    const historyTail = historyEvents.at(-1)
    if (!historyTail || historyTail.seq < ev.seq) {
      historyEvents.push(ev)
      historyEventsBySession.set(sessionId, historyEvents)
    } else {
      historyEventsBySession.set(sessionId, mergeSessionEvents(historyEvents, [ev]))
    }
    const folded = folder.fold(ev)
    if (!folded) return
    scheduleLiveRender(
      { sessionId, messages: folded.messages, isRunning: folded.isRunning },
      (render) => {
        if (get().currentSessionId !== render.sessionId) return
        const patch: Partial<DshState> = { messages: render.messages }
        if (render.isRunning !== undefined) patch.isRunning = render.isRunning
        set(patch as DshState)
      },
    )
    const needsImageHydration = folded.messages.some((message) =>
      message.parts.some((part) => part.type === 'image' && !part.src),
    )
    if (needsImageHydration) {
      const hydrationSeq = ev.seq
      void get().hydrateMessageImages(sessionId, folded.messages).then((messages) => {
        if (get().currentSessionId === sessionId && get().lastEventSeqBySession[sessionId] === hydrationSeq) {
          // 把 hydration 结果写回 fold 基线，后续增量 fold 直接在上面继续。
          folder.applyMessages(messages)
          set({ messages })
        }
      }).catch(() => {})
    }
  },

  // mux session/subscribed：host 在 (重)连后报出该 session 的 durable baseline seq。
  // baseline 只用于检测本地窗口缺口，不能冒充“已折叠 watermark”；否则与 history
  // 并发落盘的 command/done 会被误判为已处理。同一 stream generation 每个 session
  // 最多触发一次受控 history resync，避免形成 openSession 循环。
  handleSubscribed(sessionId, lastSeq, streamGeneration) {
    const priorWatermark = get().lastEventSeqBySession[sessionId] ?? -1
    subscribedLastSeqBySession.set(sessionId, lastSeq)
    // projection baseline 与 new generation 对齐（row.seq > baseline 视为重启丢失）。
    get().truncateProjections(sessionId, lastSeq)

    if (sessionId !== get().currentSessionId) return
    if (subscribedResyncGeneration.get(sessionId) === streamGeneration) return
    subscribedResyncGeneration.set(sessionId, streamGeneration)
    // baseline 与本地 watermark 一致说明无断层（初次连上也已完成 openSession 装载），
    // 无需重拉历史；有差异才 resync，避免每次启动/重连都多拉一次。
    if (lastSeq !== priorWatermark) {
      void get().openSession(sessionId).catch(() => {})
    }
  },

  setRunning(running) {
    set({ isRunning: running })
  },

  setConnected(connected) {
    set({ connected })
  },
}))
