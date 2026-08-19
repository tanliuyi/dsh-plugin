/** DSH /api 传输客户端：POST /api/<method> 一元 RPC + POST /api/respond。 */

/**
 * RpcResult 判别联合。ok:true 路径的 `value` 按契约必须存在，但运行时允许 JSON 省略
 * `value`（live host 的 `commands/execute` 对 unknown 命令返回 `result:{ok:true}`），
 * 客户端把省略后的 undefined 当作 admission miss。类型保留 `value: T` 让常规调用点
 * 无需判空；需要容忍缺省值的调用点用 `T = X | undefined` 并显式检查。
 */
export type RpcResult<T> = { ok: true; value: T } | { ok: false; error: { code: string; message: string; details?: unknown } }

const DEFAULT_RPC_TIMEOUT_MS = 30_000

function newRpcId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `rpc-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function requestSignal(signal?: AbortSignal, timeoutMs = DEFAULT_RPC_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([timeout, signal])
}

function isRpcResult<T>(value: unknown): value is RpcResult<T> {
  if (typeof value !== 'object' || value === null || typeof (value as { ok?: unknown }).ok !== 'boolean') return false
  // ok:true 允许不带 value（live host 的 commands/execute 对 unknown 命令返回
  // result:{ok:true}）；调用点把省略的 value 当 admission miss 处理。
  if ((value as { ok: boolean }).ok) return true
  const error = (value as { error?: unknown }).error
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string' && typeof (error as { message?: unknown }).message === 'string'
}

async function postJson(path: string, body: unknown, signal?: AbortSignal): Promise<Response> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: requestSignal(signal),
  })
  if (!response.ok) throw new Error(`transport failure for ${path}: HTTP ${response.status}`)
  return response
}

/** 发起有界一元调用，校验 envelope、rpcId 回显和 RpcResult 结构。 */
export async function rpc<T>(method: string, payload: unknown = {}, signal?: AbortSignal): Promise<RpcResult<T>> {
  const rpcId = newRpcId()
  const path = `/api/${method}`
  const response = await postJson(path, { type: 'client-request', rpcId, method, payload }, signal)
  let body: unknown
  try {
    body = await response.json()
  } catch (cause) {
    throw new Error(`${path}: invalid JSON response`, { cause })
  }
  if (typeof body !== 'object' || body === null || (body as { type?: unknown }).type !== 'server-response') {
    throw new Error(`${path}: unexpected response envelope`)
  }
  if ((body as { rpcId?: unknown }).rpcId !== rpcId) {
    throw new Error(`${path}: rpcId mismatch`)
  }
  const result = (body as { result?: unknown }).result
  if (!isRpcResult<T>(result)) throw new Error(`${path}: invalid RPC result`)
  return result
}

/** 对 server-request（审批/提问）应答；非 2xx 必须保留待处理交互。 */
export async function respond(rpcId: string, result: { ok: boolean; value?: unknown; error?: unknown }, signal?: AbortSignal): Promise<void> {
  await postJson('/api/respond', { type: 'client-response', rpcId, result }, signal)
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

/** Whole-list todo snapshot projected by the host for the current session. */
export type TodoStatus = 'pending' | 'in_progress' | 'completed'

export interface TodoItem {
  content: string
  status: TodoStatus
}

export interface ProjectionBaseline {
  asOfSeq: number
  values: {
    title?: unknown
    permissions?: PermissionSelect
    contextPressure?: ContextPressureProjection
    contextBreakdown?: ContextBreakdownProjection
    goal?: GoalProjection | null
    todos?: TodoItem[] | null
    [key: string]: unknown
  }
}

export interface SessionSummary {
  sessionId: string
  /** Durable title projected by the host session-title service. */
  title?: string
  projections?: ProjectionBaseline
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

export type QueueMessagePart =
  | { type: 'text'; text: string }
  | { type: 'image'; attachmentId: string; mediaType?: string; name?: string; src?: string }

export interface QueueMessage {
  /** Queue occurrence id; distinct from the durable message id. */
  id: string
  /** Durable message id used to retire a pending steering row on handoff. */
  messageId?: string
  placement: 'queued' | 'steering' | 'context'
  /** Complete per-message content, matching upstream SessionQueueMirror. */
  parts: QueueMessagePart[]
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

export type SubagentListEntry =
  | {
    kind: 'child'
    id: string
    activity: 'running' | 'inactive'
    hasChildren: boolean
    mode: 'one-shot' | 'continuable'
    label?: string
  }
  | { kind: 'diagnostic'; id: string; reason: 'corrupt' | 'unsupported' | 'unavailable' }

export interface SubagentCatalog {
  entries: SubagentListEntry[]
  parentAvailable: boolean
}

export interface SubagentAddress {
  parentSessionId: string
  childSessionId: string
  mode: 'one-shot' | 'continuable'
}

export interface SettingsSecretView {
  path: string[]
  set: boolean
}

export interface SettingsNamespaceView {
  ns: string
  schema: unknown
  value: unknown
  base?: unknown
  user?: unknown
  applies: 'live' | 'restart'
  secrets: SettingsSecretView[]
  revision: number
}

export interface SettingsDescribeResponse {
  writable: boolean
  hasDocument: boolean
  namespaces: SettingsNamespaceView[]
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

/** skill.list 目录行（对齐上游 skills.ts：/name 引用、modelInvocable 标记）。 */
export interface SkillEntry {
  name: string
  description: string
  whenToUse?: string
  modelInvocable: boolean
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

/** 上游 question.ask 单个选项（对齐 @deepseek-ai/dsh-client-ui-user-questions 的公开契约）。 */
export interface QuestionOption {
  label: string
  description?: string
}

/** 上游 question 的呈现意图：plan-review 让唯一问题渲染成一张批准决策卡，approve 指名哪个选项表示批准。 */
export interface QuestionPlanReviewIntent {
  kind: 'plan-review'
  approve: string
}

export type QuestionIntent = QuestionPlanReviewIntent

/** question/requested 载荷里的一条问题（对齐上游 ui-user-questions contract/slots.ts 的 QuestionItem）。 */
export interface Question {
  id: string
  header?: string
  question: string
  detail?: string
  options?: QuestionOption[]
  multiSelect?: boolean
  intent?: QuestionIntent
}

export type QuestionRequest = {
  type: 'question/requested'
  sessionId: string
  questions: Question[]
}

export interface PendingInteraction {
  rpcId: string
  sessionId: string
  kind: 'approval' | 'question'
  payload: ApprovalRequest | QuestionRequest
}
