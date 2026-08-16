/** zustand store：会话列表 + 当前会话消息 + mux 流状态。 */

import { create } from 'zustand'
import { rpc, type SessionSummary } from './api'
import { foldEvent, foldHistory, type DshMessage } from './messages'

export interface SessionView {
  sessionId: string
  title: string
  running: boolean
  blank: boolean
}

interface DshState {
  // 连接与宿主
  connected: boolean
  host: { version: string; cwd: string; model?: string } | null
  // 会话列表
  sessions: SessionView[]
  currentSessionId: string | null
  // 当前会话
  messages: DshMessage[]
  isRunning: boolean
  loadingHistory: boolean
  error: string | null
  // 动作
  boot: () => Promise<void>
  refreshSessions: () => Promise<void>
  openSession: (sessionId: string) => Promise<void>
  createSession: () => Promise<void>
  /** mux 帧处理入口（由 stream 层调用）。 */
  handleMuxEvent: (sessionId: string, ev: { type: string; seq: number; time: number; data: unknown }) => void
  setRunning: (running: boolean) => void
  setConnected: (connected: boolean) => void
}

export const useDsh = create<DshState>((set, get) => ({
  connected: false,
  host: null,
  sessions: [],
  currentSessionId: null,
  messages: [],
  isRunning: false,
  loadingHistory: false,
  error: null,

  async boot() {
    try {
      const result = await rpc<{ version: string; cwd: string; model?: string; provider?: string }>('host.describe')
      if (!result.ok) throw new Error(result.error.message)
      set({ host: result.value })
      await get().refreshSessions()
    } catch (error) {
      set({ error: error instanceof Error ? error.message : String(error) })
    }
  },

  async refreshSessions() {
    const result = await rpc<{ items: SessionSummary[] }>('session.list')
    if (!result.ok) return
    set({
      sessions: result.value.items.map((s) => ({
        sessionId: s.sessionId,
        title: s.cwd ?? s.sessionId,
        running: s.running,
        blank: s.blank,
      })),
    })
  },

  async openSession(sessionId) {
    set({ currentSessionId: sessionId, messages: [], loadingHistory: true, error: null })
    try {
      const result = await rpc<{ events: { event: { type: string; seq: number; time: number; data: unknown } }[] }>(
        'session.history',
        { sessionId, maxMessages: 200 },
      )
      if (!result.ok) throw new Error(result.error.message)
      const events = result.value.events.map((e) => e.event)
      set({ messages: foldHistory(events), loadingHistory: false })
    } catch (error) {
      set({ loadingHistory: false, error: error instanceof Error ? error.message : String(error) })
    }
  },

  async createSession() {
    const result = await rpc<{ sessionId: string }>('session.create', {})
    if (!result.ok) return
    await get().refreshSessions()
    await get().openSession(result.value.sessionId)
  },

  handleMuxEvent(sessionId, ev) {
    if (sessionId !== get().currentSessionId) return
    const folded = foldEvent(get().messages, ev)
    if (!folded) return
    const patch: Partial<DshState> = { messages: folded.messages }
    if (folded.isRunning !== undefined) patch.isRunning = folded.isRunning
    set(patch as DshState)
  },

  setRunning(running) {
    set({ isRunning: running })
  },

  setConnected(connected) {
    set({ connected })
  },
}))
