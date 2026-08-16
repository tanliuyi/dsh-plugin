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
import { useDsh } from '../dsh/store'
import type { DshMessage } from '../dsh/messages'

/** DshMessage → assistant-ui ThreadMessageLike。 */
function convertDshMessage(message: DshMessage): ThreadMessageLike {
  const content = message.parts.map((part) => {
    if (part.type === 'text') {
      return { type: 'text' as const, text: part.text }
    }
    if (part.type === 'reasoning') {
      return { type: 'reasoning' as const, text: part.text }
    }
    if (part.type === 'context') {
      // 上下文注入：data part，由 MessagePrimitive.Parts 的 data 配置折叠渲染。
      return { type: 'data' as const, name: 'dsh-context', data: { label: part.label, text: part.text } }
    }
    const isError = part.status === 'error'
    return {
      type: 'tool-call' as const,
      toolCallId: part.callId,
      toolName: part.toolName,
      args: (part.args ?? {}) as Record<string, unknown>,
      argsText: JSON.stringify(part.args ?? {}),
      ...(part.result !== undefined && { result: part.result }),
      ...(isError && { isError: true }),
    }
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
async function sendPrompt(sessionId: string, parts: PromptContentPart[]): Promise<void> {
  const result = await rpc('session.prompt', {
    sessionId,
    mode: 'queue',
    content: parts,
  })
  if (!result.ok) throw new Error(result.error.message)
}

export function DshRuntimeProvider({ children }: { children: React.ReactNode }) {
  const messages = useDsh((s) => s.messages)
  const isRunning = useDsh((s) => s.isRunning)
  const currentSessionId = useDsh((s) => s.currentSessionId)
  const sessions = useDsh((s) => s.sessions)
  const openSession = useDsh((s) => s.openSession)
  const createSession = useDsh((s) => s.createSession)
  const refreshSessions = useDsh((s) => s.refreshSessions)

  const converted = useExternalMessageConverter({
    callback: convertDshMessage,
    messages,
    isRunning,
    joinStrategy: 'concat-content',
  })

  const onNew = useCallback(async (message: AppendMessage) => {
    if (currentSessionId === null) throw new Error('no session open')
    const parts = toPromptParts(message)
    if (parts.length === 0) throw new Error('empty message')
    await sendPrompt(currentSessionId, parts)
  }, [currentSessionId])

  const onCancel = useCallback(async () => {
    if (currentSessionId === null) return
    const result = await rpc('session.cancel', { sessionId: currentSessionId })
    if (!result.ok) throw new Error(result.error.message)
  }, [currentSessionId])

  const threadList = useMemo<ExternalStoreThreadListAdapter>(() => ({
    threads: sessions.map((s) => ({
      status: 'regular',
      id: s.sessionId,
      title: s.title,
      custom: { running: s.running, blank: s.blank },
    })),
    onSwitchToThread: async (threadId) => {
      await openSession(threadId)
    },
    onSwitchToNewThread: async () => {
      await createSession()
    },
    onRename: async () => {},
    onArchive: async (threadId) => {
      const result = await rpc('workspace.archiveSession', { sessionId: threadId })
      if (!result.ok) throw new Error(result.error.message)
      await refreshSessions()
    },
  }), [sessions, openSession, createSession, refreshSessions])

  const runtime = useExternalStoreRuntime({
    messages: converted,
    isRunning,
    onNew,
    onCancel,
    adapters: {
      threadList,
      attachments: new SimpleImageAttachmentAdapter(),
    },
  })

  return <AssistantRuntimeProvider runtime={runtime}>{children}</AssistantRuntimeProvider>
}
