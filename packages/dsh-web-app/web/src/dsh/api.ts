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

export interface SessionSummary {
  sessionId: string
  updatedAt: number
  running: boolean
  blank: boolean
  parentSessionId?: string
  origin?: 'subagent'
  cwd?: string
  agentPreset?: string
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
