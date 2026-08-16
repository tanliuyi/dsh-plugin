/** 外部消息模型：由 SessionEvent 流组装，经 ExternalStoreAdapter 转给 assistant-ui。 */

export type DshMessagePart =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | {
    type: 'tool'
    toolName: string
    callId: string
    args: unknown
    result?: unknown
    status: 'running' | 'complete' | 'error'
  }
  /** 模型可见但用户弱化的上下文注入（runtime context、skill 目录等），折叠显示。 */
  | { type: 'context'; label: string; text: string }

export interface DshMessage {
  /** 稳定 id：优先取 wire 上的 messageId/callId，否则用事件 seq。 */
  id: string
  role: 'user' | 'assistant'
  parts: DshMessagePart[]
  createdAt?: number
  /** wire 事件 seq（组装顺序依据）。 */
  seq: number
}

/** 从一条 SessionEvent 提取消息内容文本（ContentBlock[] 或纯文本）。
 *  user/message 的 content 在 data.content；assistant/message 在 data.message.content。
 *  只取 text block（reasoning 有独立 part，不混入正文）。 */
function textOf(data: Record<string, unknown> | undefined): string {
  if (!data) return ''
  const content = data.content ?? (data.message as Record<string, unknown> | undefined)?.content
  if (content === undefined || content === null) return ''
  const parts = Array.isArray(content) ? content : [content]
  return parts
    .map((p) => {
      if (typeof p === 'string') return p
      const obj = p as Record<string, unknown>
      if (obj?.type === 'text') return String(obj.text ?? '')
      return ''
    })
    .join(' ')
}

/** 把 assistant/message 的 content blocks 解析为 parts：text / reasoning 各归其位。 */
function assistantPartsOf(data: Record<string, unknown> | undefined): DshMessagePart[] {
  const message = (data?.message ?? {}) as Record<string, unknown>
  const content = message.content
  if (content === undefined || content === null) return []
  const blocks = Array.isArray(content) ? content : [content]
  const parts: DshMessagePart[] = []
  for (const block of blocks) {
    if (typeof block === 'string') {
      if (block !== '') parts.push({ type: 'text', text: block })
      continue
    }
    const obj = block as Record<string, unknown>
    switch (obj.type) {
      case 'text':
        if (typeof obj.text === 'string' && obj.text !== '') parts.push({ type: 'text', text: obj.text })
        break
      case 'reasoning':
        if (typeof obj.text === 'string' && obj.text !== '') parts.push({ type: 'reasoning', text: obj.text })
        break
      default:
        // tool-call / image 等由独立事件（tool/call）或后续版本处理。
        break
    }
  }
  return parts
}

/** 从 data 提取消息 id（user-rpc 源的 rpcId / 通用 messageId）。 */
function messageIdOf(data: Record<string, unknown> | undefined, fallback: string): string {
  const candidate = (data?.messageId ?? data?.rpcId) as string | undefined
  return candidate ?? fallback
}

/** 上下文注入摘要上限（与官方 CONTEXT_SUMMARY_MAX_CHARS 同语义）。 */
const CONTEXT_SUMMARY_MAX_CHARS = 120

/** 从 user/message 的 source 投影折叠行的 producer 标签（官方 contextProvenance 简化版）。 */
function contextLabel(source: Record<string, unknown>): string {
  const kind = String(source.kind ?? 'unknown')
  switch (kind) {
    case 'plugin': return String(source.plugin ?? kind)
    case 'skill-invocation': return String(source.name ?? kind)
    case 'agent-instructions':
      return kind
    case 'session-reference':
      return kind
    default:
      return kind
  }
}

/** 递增组装：把一条新事件并入已有消息列表。返回 { messages, isRunning } 或 null（忽略）。 */
export function foldEvent(
  messages: DshMessage[],
  ev: { type: string; seq: number; time: number; data: unknown },
): { messages: DshMessage[]; isRunning?: boolean } | null {
  const data = (ev.data ?? {}) as Record<string, unknown>
  const base = { seq: ev.seq, createdAt: ev.time }

  switch (ev.type) {
    case 'user/message': {
      const text = textOf(data)
      if (!text) return null
      const source = (data.source ?? {}) as Record<string, unknown>
      // 只有 source.kind === 'user' 是真实用户消息；其余（plugin、skill-catalog、
      // agent-instructions、session-reference…）是模型可见的上下文注入，折叠渲染。
      if (source.kind !== 'user') {
        const label = contextLabel(source)
        const summary = text.length > CONTEXT_SUMMARY_MAX_CHARS
          ? `${text.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
          : text
        const msg: DshMessage = {
          id: `ctx-${ev.seq}`,
          role: 'assistant',
          parts: [{ type: 'context', label, text: summary }],
          ...base,
        }
        return { messages: [...messages, msg] }
      }
      const msg: DshMessage = { id: messageIdOf(data, `u-${ev.seq}`), role: 'user', parts: [{ type: 'text', text }], ...base }
      return { messages: [...messages, msg] }
    }
    case 'assistant/message': {
      const parts = assistantPartsOf(data)
      if (parts.length === 0) return null
      const msg: DshMessage = {
        id: messageIdOf(data.message as Record<string, unknown> | undefined, `a-${ev.seq}`),
        role: 'assistant',
        parts,
        ...base,
      }
      return { messages: [...messages, msg] }
    }
    case 'tool/call': {
      const callId = String(data.callId ?? `t-${ev.seq}`)
      const toolName = String(data.name ?? data.toolName ?? 'tool')
      const msg: DshMessage = {
        id: callId,
        role: 'assistant',
        parts: [{ type: 'tool', toolName, callId, args: data.arguments ?? data.args ?? {}, status: 'running' }],
        ...base,
      }
      return { messages: [...messages, msg] }
    }
    case 'tool/result': {
      // 关联键：callId 位于 message.content[0].toolCallId（顶层 data 无 callId）。
      const firstPart = (data.message?.content?.[0] ?? {}) as Record<string, unknown>
      const callId = String(firstPart.toolCallId ?? data.callId ?? '')
      if (!callId) return null
      const idx = messages.findIndex((m) => m.id === callId)
      if (idx === -1) return null
      const next = [...messages]
      const target = next[idx]!
      next[idx] = {
        ...target,
        parts: target.parts.map((p) =>
          p.type === 'tool' && p.callId === callId
            ? { ...p, status: 'complete' as const, result: firstPart.content ?? data.result ?? data.output ?? {} }
            : p,
        ),
      }
      return { messages: next }
    }
    case 'turn/start':
      return { messages, isRunning: true }
    case 'turn/end':
      return { messages, isRunning: false }
    default:
      // compaction、steering、command 等：骨架阶段忽略。
      return null
  }
}

/** 把历史事件列表组装为初始消息列表（按 seq 升序 fold）。 */
export function foldHistory(events: { type: string; seq: number; time: number; data: unknown }[]): DshMessage[] {
  let messages: DshMessage[] = []
  for (const ev of events) {
    const folded = foldEvent(messages, ev)
    if (folded) messages = folded.messages
  }
  return messages
}
