/** DSH /api 传输客户端：POST /api/<method> 一元 RPC + POST /api/respond。 */

export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

function newRpcId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** 发起一元调用，返回 result 槽。 */
export async function rpc<T>(method: string, payload: unknown = {}): Promise<RpcResult<T>> {
  const rpcId = newRpcId()
  const res = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId, method, payload }),
  })
  if (res.status === 403) throw new Error(`/api/${method}: 403 forbidden (trust fence)`)
  if (res.status === 404) throw new Error(`/api/${method}: 404 not found`)
  const body = (await res.json()) as { type: string; rpcId: string; result: RpcResult<T> }
  if (body?.type !== 'server-response') throw new Error(`/api/${method}: unexpected response`)
  return body.result
}

/** 对 server-request（审批/提问）应答。 */
export async function respond(rpcId: string, result: { ok: boolean; value?: unknown; error?: unknown }): Promise<void> {
  await fetch('/api/respond', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-response', rpcId, result }),
  })
}

// ── 常用契约类型（骨架最小集） ──────────────────────────────────────────────

export interface HostDescription {
  version: string
  cwd: string
  provider?: string
  model?: string
  attachedSessions: number
  canOpenPath: boolean
}

export interface PermissionOption {
  name: string
  value: string
}

export interface PermissionSelect {
  currentValue: string
  options: PermissionOption[]
}

export interface SessionSummary {
  sessionId: string
  /** Durable title projected by the host session-title service. */
  title?: string
  projections?: {
    values?: {
      title?: unknown
      permissions?: PermissionSelect
      contextPressure?: ContextPressureProjection
      contextBreakdown?: ContextBreakdownProjection
      goal?: GoalProjection | null
    }
  }
  parentSessionId?: string
  origin?: 'subagent'
  updatedAt: number
  running: boolean
  blank: boolean
  cwd?: string
  agentPreset?: string
}

export interface ContextPressureProjection {
  pressureTokens?: number
  projectedTokens?: number
  contextWindow?: number
}

export interface ContextBreakdownProjection {
  systemTokens?: number
  toolsTokens?: number
  messageTokens?: number
}

export interface QueueMessage {
  id: string
  placement: 'queued' | 'steering' | 'context'
  text: string
}

export interface JobView {
  id: string
  kind: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  detail?: string
  startedAt: number
  finishedAt?: number
}

export interface WorkspaceView {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt: string
  updatedAt: string
}

export interface WorkspaceListResponse {
  items: WorkspaceView[]
  archivedSessionIds?: string[]
}

export interface GoalRef {
  id: string
  revision: number
}

export interface GoalProjection {
  goal: {
    id: string
    revision: number
    objective: string
    phase: 'active' | 'paused' | 'blocked' | 'complete'
    blockedReason?: { code: string; message: string }
    maxGoalRounds: number
  }
  roundsStarted: number
  createdAt: number
  updatedAt: number
}
export interface SessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
  surfaceOp?: unknown
  ignorable?: boolean
}

export interface HistoryEntry {
  event: SessionEvent
  view?: unknown
}

export interface PromptContentPart {
  type: 'text' | 'image'
  text?: string
  mediaType?: string
  data?: string
  name?: string
}
export type ApprovalOutcome = 'allowed-once' | 'rejected'

export interface SessionAttachment {
  attachment?: {
    attachmentId?: string
    mediaType?: string
    name?: string
  }
  data: string
}
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

export interface ModelReasoningEffort {
  id: string
  name: string
  description?: string
}

export interface ModelCatalogModel {
  id: string
  name: string
  description?: string
  reasoning?: {
    efforts: ModelReasoningEffort[]
    defaultEffort?: string
  }
}

export interface ModelProviderGroup {
  id: string
  name: string
  models: ModelCatalogModel[]
}

export interface ModelCatalogResponse {
  groups: ModelProviderGroup[]
  failures?: { id: string; name: string; message: string }[]
}

export interface SessionModels {
  current: ModelSelection
  routable: boolean
  groups: ModelProviderGroup[]
  failures: { id: string; name: string; message: string }[]
}

export interface CommandEntry {
  name: string
  description?: string
  input?: { hint?: string }
}
export interface AgentPresetEntry {
  id: string
  trust: 'system' | 'user'
  isDefault: boolean
  name?: string
  description?: string
  broken?: string
}



export interface AgentPresetListResponse {
  presets: AgentPresetEntry[]
  authorable: boolean
  hasDocument: boolean
}

export interface ServerRequest<T = unknown> {
  type: 'server-request'
  rpcId: string
  method: string
  payload: T
}

export type ApprovalRequest = {
  type: 'approval/requested'
  sessionId: string
  approvalId: string
  toolName: string
  callId?: string
  reason?: string
}

export type QuestionRequest = {
  type: 'question/requested'
  sessionId: string
  questions: unknown[]
}

export interface PendingInteraction {
  rpcId: string
  sessionId: string
  kind: 'approval' | 'question'
  payload: ApprovalRequest | QuestionRequest
}
