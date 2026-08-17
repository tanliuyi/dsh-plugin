/** ExternalStoreRuntime 适配：把 zustand store 的 DshMessage 桥接给 assistant-ui。
 *  附件：SimpleImageAttachmentAdapter（dataURL）→ session.prompt 的 image parts。 */

import { useCallback, useMemo } from 'react'
import {
  AssistantRuntimeProvider,
  SimpleImageAttachmentAdapter,
  useExternalMessageConverter,
  useExternalStoreRuntime,
  type AppendMessage,
  type ExternalStoreThreadListAdapter,
  type ThreadMessageLike,
} from '@assistant-ui/react'
import { rpc, type PromptContentPart } from '../dsh/api'
import { deriveThreadListProjection } from '../dsh/thread-list'
import { useDsh } from '../dsh/store'
import type { DshMessage } from '../dsh/messages'

type ThreadContentPart = Exclude<NonNullable<ThreadMessageLike['content']>, string>[number]

/** DshMessage → assistant-ui ThreadMessageLike。 */
function convertDshMessage(message: DshMessage): ThreadMessageLike {
  const content = message.parts.flatMap((part): ThreadContentPart[] => {
    if (part.type === 'tool' && message.role !== 'assistant') return []
    if (part.type === 'text') {
      return [{ type: 'text' as const, text: part.text }]
    }
    if (part.type === 'image') {
      return [{ type: 'image' as const, image: part.src ?? '' }]
    }
    if (part.type === 'reasoning') {
      return [{ type: 'reasoning' as const, text: part.text }]
    }
    if (part.type === 'context') {
      return [{ type: 'data' as const, name: 'dsh-context', data: { label: part.label, text: part.text } }]
    }
    const isError = part.status === 'error'
    return [{
      type: 'tool-call' as const,
      toolCallId: part.callId,
      toolName: part.toolName,
      args: (part.args ?? {}) as any,
      argsText: JSON.stringify(part.args ?? {}),
      ...(part.result !== undefined && { result: part.result as any }),
      ...(isError && { isError: true }),
    }]
  })
  return {
    id: message.id,
    role: message.role,
    content,
    ...(message.createdAt !== undefined && { createdAt: new Date(message.createdAt) }),
  }
}

/** dataURL（data:image/png;base64,XXXX）→ dsh prompt image part（base64 无前缀）。 */
function dataUrlToImagePart(dataUrl: string, name?: string): PromptContentPart | null {
  const match = /^data:([a-z]+\/[a-z0-9.+-]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) return null
  const mediaType = match[1]!
  // host 只接受 png/jpeg/webp/gif（attachment-local 的媒体类型集）。
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(mediaType)) return null
  return { type: 'image', mediaType, data: match[2]!, ...(name ? { name } : {}) }
}

/** 把 assistant-ui 的 AppendMessage 转成 session.prompt 的 content parts。 */
function toPromptParts(message: AppendMessage): PromptContentPart[] {
  const parts: PromptContentPart[] = []
  for (const part of message.content) {
    if (part.type === 'text' && part.text !== '') parts.push({ type: 'text', text: part.text })
  }
  for (const attachment of message.attachments ?? []) {
    for (const content of attachment.content) {
      if (content.type === 'image') {
        const image = dataUrlToImagePart(content.image, attachment.name)
        if (image) parts.push(image)
      }
    }
  }
  return parts
}

/** 发送一条用户消息（queue 模式）。host 会经 mux 流回放 user/message 事件驱动 UI。 */
async function sendPrompt(
  sessionId: string,
  parts: PromptContentPart[],
): Promise<void> {
  const result = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: parts,
  })
  if (!result.ok) throw new Error(result.error.message)
}

async function sendSubagentPrompt(
  session: { sessionId: string; parentSessionId?: string },
  parts: PromptContentPart[],
): Promise<void> {
  if (!session.parentSessionId) throw new Error('subagent parent is unavailable')
  const catalog = await rpc<{ entries: Array<{ kind: 'child' | 'diagnostic'; id: string; mode?: 'one-shot' | 'continuable' }>; parentAvailable: boolean }>('subagent.list', {
    parentSessionId: session.parentSessionId,
  })
  if (!catalog.ok) throw new Error(catalog.error.message)
  const child = catalog.value.entries.find((entry) => entry.kind === 'child' && entry.id === session.sessionId)
  if (!child || child.kind !== 'child' || child.mode !== 'continuable') throw new Error('this subagent is read-only')
  const result = await rpc('subagent.prompt', {
    parentSessionId: session.parentSessionId,
    childSessionId: session.sessionId,
    mode: child.mode,
    content: parts,
  })
  if (!result.ok) throw new Error(result.error.message)
}

export function DshRuntimeProvider({ children }: { children: React.ReactNode }) {
  const messages = useDsh((s) => s.messages)
  const isRunning = useDsh((s) => s.isRunning)
  const currentSessionId = useDsh((s) => s.currentSessionId)
  const sessions = useDsh((s) => s.sessions)
  const workspaces = useDsh((s) => s.workspaces)
  const archivedSessionIds = useDsh((s) => s.archivedSessionIds)
  const threadListView = useDsh((s) => s.threadListView)
  const openSession = useDsh((s) => s.openSession)
  const createSession = useDsh((s) => s.createSession)
  const markSessionActive = useDsh((s) => s.markSessionActive)
  const refreshSessions = useDsh((s) => s.refreshSessions)
  const renameSession = useDsh((s) => s.renameSession)

  const converted = useExternalMessageConverter({
    callback: convertDshMessage,
    messages,
    isRunning,
    joinStrategy: 'concat-content',
  })

  const onNew = useCallback(async (message: AppendMessage) => {
    const parts = toPromptParts(message)
    if (parts.length === 0) throw new Error('empty message')
    let sessionId = useDsh.getState().currentSessionId
    if (sessionId === null) {
      await createSession()
      sessionId = useDsh.getState().currentSessionId
    }
    if (sessionId === null) throw new Error('failed to create session')
    const session = useDsh.getState().sessions.find((item) => item.sessionId === sessionId)
    if (session?.origin === 'subagent') await sendSubagentPrompt(session, parts)
    else await sendPrompt(sessionId, parts)
    markSessionActive(sessionId)
  }, [createSession, markSessionActive])

  const onCancel = useCallback(async () => {
    if (currentSessionId === null) return
    const session = useDsh.getState().sessions.find((item) => item.sessionId === currentSessionId)
    if (session?.origin === 'subagent' && session.parentSessionId) {
      const catalog = await rpc<{ entries: Array<{ kind: 'child' | 'diagnostic'; id: string; mode?: 'one-shot' | 'continuable' }> }>('subagent.list', { parentSessionId: session.parentSessionId })
      if (!catalog.ok) throw new Error(catalog.error.message)
      const child = catalog.value.entries.find((entry) => entry.kind === 'child' && entry.id === currentSessionId)
      if (!child || child.kind !== 'child' || child.mode !== 'continuable') throw new Error('this subagent is read-only')
      const result = await rpc('subagent.interrupt', { parentSessionId: session.parentSessionId, childSessionId: currentSessionId, mode: child.mode })
      if (!result.ok) throw new Error(result.error.message)
      return
    }
    const result = await rpc('session.cancel', { sessionId: currentSessionId })
    if (!result.ok) throw new Error(result.error.message)
  }, [currentSessionId])

  const projection = useMemo(
    () => deriveThreadListProjection(sessions, workspaces, archivedSessionIds, threadListView),
    [sessions, workspaces, archivedSessionIds, threadListView],
  )

  const threadList = useMemo<ExternalStoreThreadListAdapter>(() => ({
    threadId: currentSessionId ?? undefined,
    threads: projection.sessions.map((s) => ({
      status: 'regular',
      id: s.sessionId,
      title: s.title,
      lastMessageAt: new Date(s.updatedAt),
      custom: { running: s.running, blank: s.blank },
    })),
    onSwitchToThread: async (threadId) => {
      await openSession(threadId)
    },
    onSwitchToNewThread: async () => {
      await createSession(true)
    },
    onRename: async (threadId, title) => {
      await renameSession(threadId, title)
    },
    onArchive: async (threadId) => {
      const result = await rpc('workspace.archiveSession', { sessionId: threadId })
      if (!result.ok) throw new Error(result.error.message)
      await refreshSessions()
    },
    onDelete: async (threadId) => {
      const result = await rpc('workspace.archiveSession', { sessionId: threadId })
      if (!result.ok) throw new Error(result.error.message)
      await refreshSessions()
    },
  }), [currentSessionId, projection.sessions, openSession, createSession, refreshSessions, renameSession])

  const runtime = useExternalStoreRuntime({
    messages: converted,
    isRunning,
    onNew,
    onCancel,
    onEdit: async (message) => {
      const sessionId = useDsh.getState().currentSessionId
      const parts = toPromptParts(message)
      if (!sessionId || parts.length === 0) throw new Error('cannot edit an empty message')
      await sendPrompt(sessionId, parts)
    },
    onReload: async () => {
      const sessionId = useDsh.getState().currentSessionId
      if (sessionId) await openSession(sessionId)
    },
    onRefetchThread: async () => {
      const sessionId = useDsh.getState().currentSessionId
      if (sessionId) await openSession(sessionId)
    },
    adapters: {
      threadList,
      attachments: new SimpleImageAttachmentAdapter(),
    },
  })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
