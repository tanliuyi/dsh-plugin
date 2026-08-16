/** mux/host WebSocket downlink 连接管理。 */

import { useDsh } from './store'

function wsUrl(path: string): string {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${proto}://${location.host}${path}`
}

interface MuxFrame {
  type: string
  sessionId?: string
  event?: { type: string; seq: number; time: number; data: unknown }
  lastSeq?: number
  items?: unknown[]
  jobs?: unknown[]
  error?: { message?: string }
}

/** 打开两条 downlink，断线自动重连（骨架：简单定时重连）。 */
export function connectDownlinks(): void {
  const store = useDsh

  const open = (path: string, onFrame: (payload: unknown) => void): void => {
    const ws = new WebSocket(wsUrl(path))
    ws.onopen = () => {
      if (path.includes('mux')) store.setState({ connected: true })
    }
    ws.onmessage = (e) => {
      let msg: { type?: string; payload?: unknown }
      try {
        msg = JSON.parse(String(e.data))
      } catch {
        return
      }
      if (msg?.type === 'server-request') onFrame(msg.payload)
    }
    ws.onclose = () => {
      if (path.includes('mux')) store.setState({ connected: false })
      setTimeout(() => open(path, onFrame), 1000)
    }
    ws.onerror = () => ws.close()
  }

  open('/api/events.mux', (payload) => {
    const frame = payload as MuxFrame
    if (frame.type === 'session/event' && frame.sessionId && frame.event) {
      store.getState().handleMuxEvent(frame.sessionId, frame.event)
    } else if (frame.type === 'session/subscribed' && frame.sessionId && frame.lastSeq !== undefined) {
      // 订阅确认；骨架阶段无需处理。
    } else if (frame.type === 'stream/error') {
      store.setState({ error: frame.error?.message ?? 'stream error' })
    }
  })

  open('/api/events.host', () => {
    // host 级：会话创建/销毁/运行状态变化 → 刷新列表。
    void store.getState().refreshSessions().catch(() => {})
  })
}
