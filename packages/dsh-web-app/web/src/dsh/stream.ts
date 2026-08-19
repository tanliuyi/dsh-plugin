/** Upstream-compatible WebSocket downlink connection manager. */

import { type JobView, type QueueMessage, type QueueMessagePart, type ServerRequest, type WorkspaceView } from './api'
import { useDsh } from './store'

function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${path}`
}

type JsonRecord = Record<string, unknown>

interface MuxFrame {
  type: string
  sessionId?: string
  event?: { type: string; seq: number; time: number; data: unknown; surfaceOp?: unknown; ignorable?: boolean }
  questionRpcId?: string
  questions?: unknown[]
  approvalId?: string
  error?: { message?: string }
  items?: Array<{
    id: string
    placement: QueueMessage['placement']
    message?: { id?: string; content?: unknown[] }
  }>
  lastSeq?: number
  jobs?: JobView[]
  key?: string
  value?: unknown
  seq?: number
}

type HostFrame = JsonRecord & { type: string }

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
}

/** Preserve each queue occurrence's own text/image content, as upstream does. */
export function queuePartsOf(content: unknown[] | undefined): QueueMessagePart[] {
  if (!content) return []
  return content.flatMap((block): QueueMessagePart[] => {
    if (!isRecord(block)) return []
    if (block.type === 'text' && typeof block.text === 'string') {
      return [{ type: 'text', text: block.text }]
    }
    if (block.type !== 'image') return []
    const attachment = isRecord(block.attachment) ? block.attachment : block
    const attachmentId = String(attachment.attachmentId ?? attachment.id ?? '')
    if (!attachmentId) return []
    return [{
      type: 'image',
      attachmentId,
      ...(typeof attachment.mediaType === 'string' ? { mediaType: attachment.mediaType } : {}),
      ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
    }]
  })
}

function isServerRequest(value: unknown): value is ServerRequest {
  return isRecord(value) && value.type === 'server-request' && typeof value.rpcId === 'string' && typeof value.method === 'string'
}

function isMuxFrame(value: unknown): value is MuxFrame {
  return isRecord(value) && typeof value.type === 'string' && (
    value.type === 'session/event' ||
    value.type === 'session/subscribed' ||
    value.type === 'approval/requested' ||
    value.type === 'question/requested' ||
    value.type === 'question/resolved' ||
    value.type === 'approval/resolved' ||
    value.type === 'session/queue' ||
    value.type === 'session/jobs' ||
    value.type === 'session/projection' ||
    value.type === 'llm/adapters-updated' ||
    value.type === 'settings/document-updated' ||
    value.type === 'stream/error'
  )
}

function isHostFrame(value: unknown): value is HostFrame {
  return isRecord(value) && typeof value.type === 'string' && (
    value.type.startsWith('host/') || value.type === 'stream/error'
  )
}

let started = false
let generation = 0
let reconnectAttempt = 0
let reconnectTimer: ReturnType<typeof setTimeout> | undefined

/** Open both downlinks as one generation, matching the upstream client contract. */
export function connectDownlinks(): void {
  if (started) return
  started = true
  startGeneration()
}

function startGeneration(): void {
  const currentGeneration = ++generation
  const store = useDsh
  let muxReady = false
  let hostReady = false
  let retryScheduled = false
  const sockets: WebSocket[] = []

  store.setState({
    connected: false,
    modelRoutable: null,
    modelCatalogSessionId: null,
    modelCatalogGroups: [],
    modelCatalog: [],
    selectedProvider: null,
    selectedModel: null,
    selectedReasoningEffort: undefined,
  })

  const failGeneration = (): void => {
    if (currentGeneration !== generation) return
    store.setState({ connected: false })
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
    }
    if (retryScheduled) return
    retryScheduled = true
    const base = Math.min(10_000, 500 * 2 ** reconnectAttempt)
    reconnectAttempt += 1
    const delay = Math.round(base * (0.8 + Math.random() * 0.4))
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      if (currentGeneration === generation) startGeneration()
    }, delay)
  }

  const markReady = (kind: 'mux' | 'host'): void => {
    if (kind === 'mux') muxReady = true
    else hostReady = true
    if (muxReady && hostReady && currentGeneration === generation) {
      reconnectAttempt = 0
      store.setState({ connected: true })
      const sessionId = store.getState().currentSessionId
      if (sessionId) void store.getState().loadSessionModels(sessionId)
    }
  }

  const handleMux = (payload: unknown, request?: ServerRequest): void => {
    if (isServerRequest(payload)) {
      store.getState().addPendingInteraction(payload)
      return
    }
    if (!isMuxFrame(payload)) return
    if ((payload.type === 'approval/requested' || payload.type === 'question/requested') && request) {
      store.getState().addPendingInteraction({ ...request, payload })
      return
    }
    if (payload.type === 'session/subscribed' && payload.sessionId && typeof payload.lastSeq === 'number') {
      // 对齐该 session 的 event watermark 与新 generation baseline，并按需受控 resync。
      store.getState().handleSubscribed(payload.sessionId, payload.lastSeq, currentGeneration)
    } else if (payload.type === 'session/event' && payload.sessionId && payload.event && typeof payload.event.seq === 'number') {
      store.getState().handleMuxEvent(payload.sessionId, payload.event)
    } else if (payload.type === 'approval/resolved' && typeof payload.approvalId === 'string') {
      store.getState().resolveApproval(payload.approvalId)
    } else if (payload.type === 'question/resolved' && typeof payload.questionRpcId === 'string') {
      store.getState().resolveInteraction(payload.questionRpcId)
    } else if (payload.type === 'session/queue' && payload.sessionId && Array.isArray(payload.items)) {
      store.getState().setQueueSnapshot(payload.sessionId, payload.items.map((item) => {
        const parts = queuePartsOf(item.message?.content)
        return {
          id: item.id,
          ...(item.message?.id ? { messageId: item.message.id } : {}),
          placement: item.placement,
          parts,
          text: parts.flatMap((part) => part.type === 'text' ? [part.text] : []).join('').trim() || 'Queued message',
        }
      }))
    } else if (payload.type === 'session/jobs' && payload.sessionId && Array.isArray(payload.jobs)) {
      store.getState().setJobsSnapshot(payload.sessionId, payload.jobs)
    } else if (payload.type === 'session/projection' && payload.sessionId && typeof payload.key === 'string' && typeof payload.seq === 'number') {
      store.getState().setProjection(payload.sessionId, payload.key, payload.value, payload.seq)
    } else if (payload.type === 'llm/adapters-updated' || payload.type === 'settings/document-updated') {
      const sessionId = store.getState().currentSessionId
      if (sessionId) void store.getState().loadSessionModels(sessionId)
    } else if (payload.type === 'stream/error') {
      failGeneration()
    }
  }

  const handleHost = (payload: unknown, request?: ServerRequest): void => {
    if (isServerRequest(payload)) {
      store.getState().addPendingInteraction(payload)
      return
    }
    if (!isHostFrame(payload)) return
    const type = payload.type
    if (type === 'stream/error') {
      failGeneration()
      return
    }
    if (type === 'host/session-status' && typeof payload.sessionId === 'string' && typeof payload.running === 'boolean') {
      const sessionId = payload.sessionId
      const running = payload.running
      store.getState().setSessionRunning(sessionId, running)
      return
    }
    if (type === 'host/agent-error' && typeof payload.message === 'string') {
      store.setState({ error: payload.message })
      return
    }
    if (type === 'host/session-removed' && typeof payload.sessionId === 'string') {
      store.getState().removeSessionState(payload.sessionId)
      return
    }
    if (type === 'host/archived-sessions-changed' && Array.isArray(payload.archivedSessionIds)) {
      store.setState({ archivedSessionIds: payload.archivedSessionIds.filter((id): id is string => typeof id === 'string') })
      return
    }
    // 上游把 allowlist 内宿主事件统一经 host/remote-event 转发（events.ts）。
    // llm/adapters-updated、settings/document-updated、credentials/updated 触发
    // 模型目录/设置热更新，其余 remote event 保持静默——绝不发起全量 session.list 刷新。
    if (type === 'host/remote-event' && typeof payload.event === 'string') {
      const event = payload.event
      if (
        event === 'llm/adapters-updated' ||
        event === 'settings/document-updated' ||
        event === 'credentials/updated'
      ) {
        const sessionId = store.getState().currentSessionId
        if (sessionId) void store.getState().loadSessionModels(sessionId)
      }
      return
    }
    // Workspace 推流帧：全快照/删除增量/注册表顺序，本地应用，不整表刷新。
    if (type === 'host/workspace-changed') {
      const workspace = (payload as { workspace?: unknown }).workspace
      if (
        typeof workspace === 'object' && workspace !== null &&
        typeof (workspace as { workspaceId?: unknown }).workspaceId === 'string'
      ) {
        store.getState().applyHostWorkspaceChanged(workspace as WorkspaceView)
      }
      return
    }
    if (type === 'host/workspace-removed') {
      const workspaceId = payload.workspaceId
      if (typeof workspaceId === 'string') store.getState().applyHostWorkspaceRemoved(workspaceId)
      return
    }
    if (type === 'host/workspace-order-changed') {
      const workspaceIds = payload.workspaceIds
      if (Array.isArray(workspaceIds)) {
        store.getState().applyHostWorkspaceOrder(workspaceIds.filter((id): id is string => typeof id === 'string'))
      }
      return
    }
    // session-added 等其余 host 帧：回到 list-baseline（session.list + workspace.list）。
    void store.getState().refreshSessions().catch(() => {})
  }

  const open = (path: string, kind: 'mux' | 'host', handle: (payload: unknown, request?: ServerRequest) => void): void => {
    const ws = new WebSocket(wsUrl(path))
    sockets.push(ws)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => markReady(kind)
    ws.onmessage = (event) => {
      if (currentGeneration !== generation) return
      if (typeof event.data !== 'string') {
        console.error(`[dsh-web-app] dropping non-text WebSocket frame on ${path}`)
        return
      }
      let envelope: unknown
      try {
        envelope = JSON.parse(event.data)
      } catch (error) {
        console.error(`[dsh-web-app] dropping malformed WebSocket frame on ${path}`, error)
        return
      }
      // The current host wraps payloads in server-request envelopes. Raw frames
      // remain accepted for compatible older carriers.
      if (isServerRequest(envelope)) {
        handle(envelope.payload, envelope)
      } else if (isMuxFrame(envelope) || isHostFrame(envelope)) {
        handle(envelope)
      } else {
        console.error(`[dsh-web-app] dropping invalid WebSocket envelope on ${path}`)
      }
    }
    ws.onclose = failGeneration
    ws.onerror = failGeneration
  }

  open('/api/events.mux', 'mux', handleMux)
  open('/api/events.host', 'host', handleHost)
}
