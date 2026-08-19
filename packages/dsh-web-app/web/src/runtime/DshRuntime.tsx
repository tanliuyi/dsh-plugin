/** ExternalStoreRuntime 适配：把 zustand store 的 DshMessage 桥接给 assistant-ui。
 *  附件：SimpleImageAttachmentAdapter（dataURL）→ session.prompt 的 image parts。 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
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
import { resolveCommandDisposition, commandDraftOf } from '../dsh/commands'
import { deriveThreadListProjection } from '../dsh/thread-list'
import { useDsh } from '../dsh/store'
import type { DshMessage } from '../dsh/messages'
import { useThreadNavigation } from '../router-navigation'

type ThreadContentPart = Exclude<NonNullable<ThreadMessageLike['content']>, string>[number]

/** DshMessage → assistant-ui ThreadMessageLike。
 *  steering 角色对 assistant-ui 而言只能是 user/assistant，这里用 assistant 承载，
 *  但 thread 渲染层按 store 原数据拦截成与上游一致的 user-style steering 气泡，
 *  不落成普通 assistant 正文。 */
function convertDshMessage(message: DshMessage): ThreadMessageLike {
  const role: 'user' | 'assistant' = message.role === 'steering' ? 'assistant' : message.role
  const steeringImages = message.parts.flatMap((part) =>
    part.type === 'image'
      ? [{
          type: 'image' as const,
          attachmentId: part.attachmentId,
          mediaType: part.mediaType,
          src: part.src,
          name: part.name,
        }]
      : [],
  )
  const content = message.parts.flatMap((part): ThreadContentPart[] => {
    if (part.type === 'tool' && role !== 'assistant') return []
    if (part.type === 'text') {
      return [{ type: 'text' as const, text: part.text }]
    }
    if (part.type === 'steering') {
      return [{
        type: 'data' as const,
        name: 'dsh-steering',
        data: { text: part.text, images: steeringImages },
      }]
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
    if (part.type === 'compaction') {
      return [{ type: 'data' as const, name: 'dsh-compaction', data: part }]
    }
    if (part.type === 'generation-status') {
      return [{
        type: 'data' as const,
        name: 'dsh-generation-status',
        data: {
          state: part.state,
          title: part.title,
          detail: part.detail,
          retry: part.retry,
          maxRetries: part.maxRetries,
        },
      }]
    }
    if (part.type === 'command') {
      return [{
        type: 'data' as const,
        name: 'dsh-command',
        data: {
          commandId: part.commandId,
          commandName: part.name,
          args: part.args,
          outcome: part.outcome,
          compaction: part.compaction,
        },
      }]
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
    role,
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

function clientTimeZone(): string | undefined {
  try {
    const value = Intl.DateTimeFormat().resolvedOptions().timeZone
    return value.trim() === '' ? undefined : value
  } catch {
    return undefined
  }
}

/** Send one admitted prompt; the durable user/message event remains the UI authority. */
async function sendPrompt(
  sessionId: string,
  parts: PromptContentPart[],
  mode: 'queue' | 'steer' = 'queue',
): Promise<void> {
  const timeZone = clientTimeZone()
  const result = await rpc<{ accepted: true }>('session.prompt', {
    sessionId,
    mode,
    content: parts,
    ...(timeZone === undefined ? {} : { clientTimeZone: timeZone }),
  })
  if (!result.ok) throw new Error(`conversation.send failed: ${result.error.code}: ${result.error.message}`)
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
  if (parts.some((part) => part.type === 'image')) throw new Error('Image input is unavailable for subagent continuations.')
  const timeZone = clientTimeZone()
  const result = await rpc('subagent.prompt', {
    parentSessionId: session.parentSessionId,
    childSessionId: session.sessionId,
    mode: child.mode,
    content: parts.flatMap((part) => part.type === 'text' ? [{ type: 'text' as const, text: part.text ?? '' }] : []),
    ...(timeZone === undefined ? {} : { clientTimeZone: timeZone }),
  })
  if (!result.ok) throw new Error(`conversation.send failed: ${result.error.code}: ${result.error.message}`)
}

export function DshRuntimeProvider({ children }: { children: React.ReactNode }) {
  const messages = useDsh((s) => s.messages)
  const previousMessagesRef = useRef<readonly DshMessage[]>(messages)
  const historyJoinBoundaryIdsRef = useRef<ReadonlySet<string>>(new Set())
  const historyJoinBoundaryIds = useMemo(() => {
    const previousMessages = previousMessagesRef.current
    let next = historyJoinBoundaryIdsRef.current
    if (previousMessages.length > 0 && messages.length > previousMessages.length) {
      const previousFirstId = previousMessages[0]?.id
      const previousFirstIndex = previousFirstId
        ? messages.findIndex((message) => message.id === previousFirstId)
        : -1
      if (previousFirstIndex > 0) {
        const boundaryMessage = messages[previousFirstIndex - 1]
        if (
          boundaryMessage &&
          boundaryMessage.role !== 'user' &&
          !next.has(boundaryMessage.id)
        ) {
          next = new Set(next).add(boundaryMessage.id)
        }
      }
    }
    return next
  }, [messages])
  useEffect(() => {
    previousMessagesRef.current = messages
    historyJoinBoundaryIdsRef.current = historyJoinBoundaryIds
  }, [historyJoinBoundaryIds, messages])
  const convertMessage = useCallback((message: DshMessage) => {
    const convertedMessage = convertDshMessage(message)
    if (
      convertedMessage.role !== 'assistant' ||
      !historyJoinBoundaryIds.has(message.id)
    ) {
      return convertedMessage
    }
    return {
      ...convertedMessage,
      convertConfig: { joinStrategy: 'none' as const },
    }
  }, [historyJoinBoundaryIds])
  const isRunning = useDsh((s) => s.isRunning)
  const currentSessionId = useDsh((s) => s.currentSessionId)
  const sessions = useDsh((s) => s.sessions)
  const workspaces = useDsh((s) => s.workspaces)
  const archivedSessionIds = useDsh((s) => s.archivedSessionIds)
  const pendingInteractions = useDsh((s) => s.pendingInteractions)
  const threadListView = useDsh((s) => s.threadListView)
  const openSession = useDsh((s) => s.openSession)
  const createSession = useDsh((s) => s.createSession)
  const markSessionActive = useDsh((s) => s.markSessionActive)
  const refreshSessions = useDsh((s) => s.refreshSessions)
  const renameSession = useDsh((s) => s.renameSession)
  const executeCommand = useDsh((s) => s.executeCommand)
  const navigateToThread = useThreadNavigation()

  const converted = useExternalMessageConverter({
    callback: convertMessage,
    messages,
    isRunning,
    joinStrategy: 'concat-content',
  })

  const onNew = useCallback(async (message: AppendMessage) => {
    const parts = toPromptParts(message)
    if (parts.length === 0) throw new Error('empty message')

    let sessionId = useDsh.getState().currentSessionId
    if (sessionId === null) {
      const createdSessionId = await createSession()
      sessionId = createdSessionId ?? useDsh.getState().currentSessionId
      if (createdSessionId !== null) await navigateToThread(createdSessionId)
    }
    if (sessionId === null) throw new Error('failed to create session')

    const state = useDsh.getState()
    const session = state.sessions.find((item) => item.sessionId === sessionId)
    const commandDraft = commandDraftOf(
      message.content,
      (message.attachments?.length ?? 0) > 0,
    )

    // Subagents have no agent-bound host command catalog. Their slash lines,
    // including skills, remain ordinary continuation prompts.
    if (commandDraft !== null && session?.origin !== 'subagent') {
      const stateNow = useDsh.getState()
      let commands = stateNow.commands
      if (stateNow.commandsSessionId !== sessionId || stateNow.commandLoadError !== null) {
        // loadCommands 失败时不再向外抛：记录 commandLoadError 并保留最后一次缓存。
        commands = await stateNow.loadCommands(sessionId)
      }
      const disposition = resolveCommandDisposition(
        commandDraft,
        commands,
        useDsh.getState().commandLoadError,
        // skills 只属于发起时的 session：skillsSessionId 不匹配（旧 session 残留）绝不传入。
        useDsh.getState().skillsSessionId === sessionId ? useDsh.getState().skills : [],
      )
      if (disposition.kind === 'execute') {
        await executeCommand(disposition.line, sessionId)
        return
      }
      if (disposition.kind === 'unavailable') {
        // 上游语义：目录故障时任何可识别 slash 都报错并保留输入，绝不落 prompt。
        throw new Error(`command catalog is unavailable — input kept; retry /${disposition.name} later`)
      }
    }

    if (session?.origin === 'subagent') await sendSubagentPrompt(session, parts)
    else await sendPrompt(sessionId, parts, useDsh.getState().isRunning ? 'steer' : 'queue')
    markSessionActive(sessionId)
  }, [createSession, executeCommand, markSessionActive, navigateToThread])

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
      custom: {
        running: s.running,
        blank: s.blank,
        hasPendingRequest: pendingInteractions.some((item) => item.sessionId === s.sessionId),
      },
    })),
    onSwitchToThread: async (threadId) => {
      await navigateToThread(threadId)
    },
    onSwitchToNewThread: async () => {
      const createdSessionId = await createSession(true)
      if (createdSessionId !== null) await navigateToThread(createdSessionId)
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
  }), [currentSessionId, projection.sessions, pendingInteractions, navigateToThread, createSession, refreshSessions, renameSession])

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
