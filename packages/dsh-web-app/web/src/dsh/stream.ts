/** Upstream-compatible WebSocket downlink connection manager. */

import { type JobView, type QueueMessage, type ServerRequest } from './api'
import { useDsh } from './store'

function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${path}`
}

type JsonRecord = Record<string, unknown>

interface MuxFrame {
  type: string
  sessionId?: string
  event?: { type: string; seq: number; time: number; data: unknown }
  questionRpcId?: string
  questions?: unknown[]
  approvalId?: string
  error?: { message?: string }
  items?: Array<{ id: string; placement: QueueMessage['placement']; message?: { content?: Array<{ type?: string; text?: string }> } }>
  jobs?: JobView[]
  key?: string
  value?: unknown
  seq?: number
}

interface HostFrame {
  type: string
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null
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
    value.type === 'approval/resolved' ||
    value.type === 'session/queue' ||
    value.type === 'session/jobs' ||
    value.type === 'session/projection' ||
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

  store.setState({ connected: false })

  const failGeneration = (): void => {
    if (currentGeneration !== generation) return
    store.setState({ connected: false })
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close()
    }
    if (retryScheduled) return
    retryScheduled = true
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined
      if (currentGeneration === generation) startGeneration()
    }, 1000)
  }

  const markReady = (kind: 'mux' | 'host'): void => {
    if (kind === 'mux') muxReady = true
    else hostReady = true
    if (muxReady && hostReady && currentGeneration === generation) store.setState({ connected: true })
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
    if (payload.type === 'session/event' && payload.sessionId && payload.event && typeof payload.event.seq === 'number') {
      store.getState().handleMuxEvent(payload.sessionId, payload.event)
    } else if (payload.type === 'approval/resolved' && typeof payload.approvalId === 'string') {
      store.getState().resolveApproval(payload.approvalId)
    } else if (payload.type === 'question/resolved' && typeof payload.questionRpcId === 'string') {
      store.getState().resolveInteraction(payload.questionRpcId)
    } else if (payload.type === 'session/queue' && payload.sessionId && Array.isArray(payload.items)) {
      store.getState().setQueueSnapshot(payload.sessionId, payload.items.map((item) => ({
        id: item.id,
        placement: item.placement,
        text: item.message?.content?.filter((part) => part.type === 'text').map((part) => part.text ?? '').join(' ').trim() || 'Queued message',
      })))
    } else if (payload.type === 'session/jobs' && payload.sessionId && Array.isArray(payload.jobs)) {
      store.getState().setJobsSnapshot(payload.sessionId, payload.jobs)
    } else if (payload.type === 'session/projection' && payload.sessionId && typeof payload.key === 'string' && typeof payload.seq === 'number') {
      store.getState().setProjection(payload.sessionId, payload.key, payload.value, payload.seq)
    } else if (payload.type === 'stream/error') {
      store.setState({ error: payload.error?.message ?? 'stream error' })
    }
  }

  const handleHost = (payload: unknown, request?: ServerRequest): void => {
    if (isServerRequest(payload)) {
      store.getState().addPendingInteraction(payload)
      return
    }
    if (isHostFrame(payload)) {
      void store.getState().refreshSessions().catch(() => {})
    }
  }

  const open = (path: string, kind: 'mux' | 'host', handle: (payload: unknown, request?: ServerRequest) => void): void => {
    const ws = new WebSocket(wsUrl(path))
    sockets.push(ws)
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => markReady(kind)
    ws.onmessage = (event) => {
      if (currentGeneration !== generation || typeof event.data !== 'string') {
        failGeneration()
        return
      }
      let envelope: unknown
      try {
        envelope = JSON.parse(event.data)
      } catch {
        failGeneration()
        return
      }
      if (!isServerRequest(envelope)) {
        failGeneration()
        return
      }
      handle(envelope.payload, envelope)
    }
    ws.onclose = failGeneration
    ws.onerror = failGeneration
  }

  open('/api/events.mux', 'mux', handleMux)
  open('/api/events.host', 'host', handleHost)
}
