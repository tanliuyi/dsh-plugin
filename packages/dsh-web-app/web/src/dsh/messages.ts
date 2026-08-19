/** 外部消息模型：由 SessionEvent 流组装，经 ExternalStoreAdapter 转给 assistant-ui。 */

export type DshMessagePart =
  | { type: 'text'; text: string }
  | /** 活跃 turn 中注入的用户输入（上游 SteeringMessageNode）：复用 user-style 气泡。 */
  { type: 'steering'; text: string }
  | { type: 'image'; attachmentId: string; mediaType?: string; name?: string; src?: string }
  | { type: 'reasoning'; text: string }
  | {
    type: 'tool'
    toolName: string
    callId: string
    args: unknown
    result?: unknown
    isError?: boolean
    error?: unknown
    status: 'running' | 'complete' | 'error'
  }
  /** 模型可见但用户弱化的上下文注入（runtime context、skill 目录等），折叠显示。 */
  | { type: 'context'; label: string; text: string }
  | {
    type: 'generation-status'
    state: 'error' | 'retrying'
    title: string
    detail: string
    retry?: number
    maxRetries?: number
  }
  | {
    type: 'compaction'
    compactionId: string
    summary: string | null
    shadowedItemCount: number | null
    shadowedTokenCount: number | null
  }
  | {
    type: 'command'
    commandId: string
    name: string | null
    args: string | null
    outcome: null | { kind: 'success' | 'error'; text?: string; sourceEventSeq?: number }
    compaction?: Extract<DshMessagePart, { type: 'compaction' }>
  }

export interface FoldableSessionEvent {
  type: string
  seq: number
  time: number
  data: unknown
  surfaceOp?: unknown
  ignorable?: boolean
}

export interface DshMessage {
  /** 稳定 id：优先取 wire 上的 messageId/callId，否则用事件 seq。 */
  id: string
  /** steering：被 next-step inbox claim 的 user 输入，渲染为 user-style steering 气泡。 */
  role: 'user' | 'assistant' | 'steering'
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

function contentBlocksOf(data: Record<string, unknown> | undefined): Record<string, unknown>[] {
  if (!data) return []
  const content = data.content ?? (data.message as Record<string, unknown> | undefined)?.content
  const blocks = Array.isArray(content) ? content : content == null ? [] : [content]
  return blocks.filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null)
}

function imagePartsOf(data: Record<string, unknown> | undefined): DshMessagePart[] {
  return contentBlocksOf(data).flatMap((block) => {
    if (block.type !== 'image') return []
    const attachment = (block.attachment ?? block) as Record<string, unknown>
    const attachmentId = String(attachment.attachmentId ?? attachment.id ?? '')
    if (!attachmentId) return []
    return [{
      type: 'image' as const,
      attachmentId,
      mediaType: typeof attachment.mediaType === 'string' ? attachment.mediaType : undefined,
      name: typeof attachment.name === 'string' ? attachment.name : undefined,
    }]
  })
}


type CompactionPart = Extract<DshMessagePart, { type: 'compaction' }>

type CompactionSummaryData = {
  summary: string | null
  shadowedItemCount: number | null
  shadowedTokenCount: number | null
}

function compactionSummaryOf(data: Record<string, unknown>): CompactionSummaryData {
  const blocks = Array.isArray(data.summary) ? data.summary : []
  const summary = blocks
    .map((block) => typeof block === 'object' && block !== null && (block as Record<string, unknown>).type === 'text'
      ? String((block as Record<string, unknown>).text ?? '')
      : '')
    .join('')
  const shadowedSeqs = Array.isArray(data.shadowedSeqs)
    && data.shadowedSeqs.every((seq) => Number.isSafeInteger(seq) && Number(seq) >= 0)
    ? data.shadowedSeqs
    : null
  return {
    summary: summary.trim() === '' ? null : summary,
    shadowedItemCount: shadowedSeqs?.length ?? null,
    shadowedTokenCount: Number.isSafeInteger(data.shadowedTokenCount) && Number(data.shadowedTokenCount) >= 0
      ? Number(data.shadowedTokenCount)
      : null,
  }
}

function compactCheckpointSource(ev: FoldableSessionEvent, data: Record<string, unknown>): {
  compactionId: string
  sourceCommandId?: string
} | null {
  if (ev.type !== 'user/message' || typeof ev.surfaceOp !== 'object' || ev.surfaceOp === null) return null
  if ((ev.surfaceOp as Record<string, unknown>).op !== 'replace') return null
  const source = (data.source ?? {}) as Record<string, unknown>
  if (source.kind !== 'plugin' || source.plugin !== 'compact' || typeof source.compactionId !== 'string' || source.compactionId === '') return null
  return {
    compactionId: source.compactionId,
    ...(typeof source.sourceCommandId === 'string' && source.sourceCommandId !== ''
      ? { sourceCommandId: source.sourceCommandId }
      : {}),
  }
}

function collectedLabels(source: Record<string, unknown>, member: string, field: string): string[] {
  const values = source[member]
  if (!Array.isArray(values)) return []
  const labels: string[] = []
  for (const value of values) {
    if (typeof value !== 'object' || value === null) continue
    const label = (value as Record<string, unknown>)[field]
    if (typeof label === 'string' && label !== '' && !labels.includes(label)) labels.push(label)
  }
  return labels
}

function contextLabel(source: Record<string, unknown>): string {
  const kind = typeof source.kind === 'string' && source.kind !== '' ? source.kind : 'unknown'
  switch (kind) {
    case 'plugin': return typeof source.plugin === 'string' && source.plugin !== '' ? source.plugin : kind
    case 'skill-invocation': return typeof source.name === 'string' && source.name !== '' ? source.name : kind
    case 'agent-instructions': return collectedLabels(source, 'changes', 'path').join(', ') || kind
    case 'session-reference': return collectedLabels(source, 'references', 'label').join(', ') || kind
    default: return kind
  }
}

function partialMessageId(data: Record<string, unknown>): string {
  return `partial-${String(data.turn ?? 'unknown')}-${String(data.step ?? '0')}`
}

function blockText(block: unknown): string {
  return typeof block === 'object' && block !== null && typeof (block as Record<string, unknown>).text === 'string'
    ? String((block as Record<string, unknown>).text)
    : ''
}

function applyAssistantChunk(messages: DshMessage[], data: Record<string, unknown>, base: { seq: number; createdAt: number }): DshMessage[] {
  const chunk = (data.chunk ?? {}) as Record<string, unknown>
  const kind = String(chunk.type ?? '')
  const index = typeof chunk.index === 'number' ? chunk.index : 0
  const id = partialMessageId(data)
  const existingIndex = messages.findIndex((message) => message.id === id)
  const existing = existingIndex >= 0 ? messages[existingIndex]! : {
    id,
    role: 'assistant' as const,
    parts: [],
    ...base,
  }
  const parts = [...existing.parts]
  const blockType = kind === 'reasoning-delta' || chunk.blockType === 'reasoning' || (chunk.block as Record<string, unknown> | undefined)?.type === 'reasoning'
    ? 'reasoning'
    : 'text'
  const current = parts[index]

  if (kind === 'block-start') {
    parts[index] = blockType === 'reasoning' ? { type: 'reasoning', text: '' } : { type: 'text', text: '' }
  } else if (kind === 'reasoning-delta' || kind === 'text-delta') {
    const text = typeof chunk.text === 'string' ? chunk.text : ''
    const targetType = kind === 'reasoning-delta' ? 'reasoning' : 'text'
    parts[index] = current?.type === targetType
      ? { ...current, text: current.text + text }
      : { type: targetType, text }
  } else if (kind === 'block-end') {
    const block = (chunk.block ?? {}) as Record<string, unknown>
    if (block.type === 'reasoning' || block.type === 'text') {
      parts[index] = { type: block.type, text: blockText(block) }
    }
  } else {
    return messages
  }

  const next = { ...existing, parts, ...base }
  if (existingIndex >= 0) {
    const result = [...messages]
    result[existingIndex] = next
    return result
  }
  return [...messages, next]
}

/** 解析最终 assistant/message；实时 partial 会在同一 turn/step 上原地替换。 */
function generationStatusId(data: Record<string, unknown>): string {
  return `generation-status-${String(data.turn ?? 'unknown')}-${String(data.step ?? '0')}`
}

function withoutGenerationStatus(messages: DshMessage[], data: Record<string, unknown>): DshMessage[] {
  const id = generationStatusId(data)
  return messages.some((message) => message.id === id)
    ? messages.filter((message) => message.id !== id)
    : messages
}

function failureDetail(value: unknown): string {
  if (typeof value === 'string' && value !== '') return value
  if (typeof value !== 'object' || value === null) return 'The model request failed.'
  const failure = value as Record<string, unknown>
  const message = typeof failure.message === 'string' ? failure.message : 'The model request failed.'
  const code = typeof failure.code === 'string' ? failure.code : undefined
  return code ? `${message} (${code})` : message
}

function upsertGenerationStatus(
  messages: DshMessage[],
  data: Record<string, unknown>,
  base: { seq: number; createdAt: number },
  part: Extract<DshMessagePart, { type: 'generation-status' }>,
): DshMessage[] {
  const id = generationStatusId(data)
  const message: DshMessage = { id, role: 'assistant', parts: [part], ...base }
  const index = messages.findIndex((item) => item.id === id)
  if (index < 0) return [...messages, message]
  const next = [...messages]
  next[index] = message
  return next
}

function finalizedAssistantMessage(messages: DshMessage[], data: Record<string, unknown>, base: { seq: number; createdAt: number }, parts: DshMessagePart[]): DshMessage[] {
  const clean = withoutGenerationStatus(messages, data)
  const message = data.message as Record<string, unknown> | undefined
  const id = messageIdOf(message, `a-${base.seq}`)
  const finalized: DshMessage = { id, role: 'assistant', parts, ...base }
  const partialIndex = clean.findIndex((item) => item.id === partialMessageId(data))
  if (partialIndex < 0) return [...clean, finalized]
  const result = [...clean]
  result[partialIndex] = finalized
  return result
}

/** 递增组装：把一条新事件并入已有消息列表。返回 { messages, isRunning } 或 null（忽略）。
 *  可选 claimed 为上游 inbox 的 next-step claimed 集合：source.kind=user 且 id 被 claim
 *  的 user/message 折叠为 steering 节点（非 user 气泡）。 */
export function foldEvent(
  messages: DshMessage[],
  ev: FoldableSessionEvent,
  claimed?: ReadonlySet<string>,
  compactionSummaries?: Map<string, CompactionSummaryData>,
): { messages: DshMessage[]; isRunning?: boolean } | null {
  const data = (ev.data ?? {}) as Record<string, unknown>
  const base = { seq: ev.seq, createdAt: ev.time }

  switch (ev.type) {
    case 'compaction/summary': {
      if (typeof data.compactionId !== 'string' || data.compactionId === '') return null
      compactionSummaries?.set(data.compactionId, compactionSummaryOf(data))
      return null
    }
    case 'user/message': {
      const checkpoint = compactCheckpointSource(ev, data)
      if (checkpoint !== null) {
        const summary = compactionSummaries?.get(checkpoint.compactionId)
        const compaction: CompactionPart = {
          type: 'compaction',
          compactionId: checkpoint.compactionId,
          summary: summary?.summary ?? null,
          shadowedItemCount: summary?.shadowedItemCount ?? null,
          shadowedTokenCount: summary?.shadowedTokenCount ?? null,
        }
        compactionSummaries?.delete(checkpoint.compactionId)
        if (checkpoint.sourceCommandId !== undefined) {
          const id = `cmd-${checkpoint.sourceCommandId}`
          const existingIndex = messages.findIndex((message) => message.id === id)
          if (existingIndex >= 0) {
            const next = [...messages]
            const existing = next[existingIndex]!
            next[existingIndex] = {
              ...existing,
              parts: existing.parts.map((part) => part.type === 'command' ? { ...part, compaction } : part),
            }
            return { messages: next }
          }
          return {
            messages: [...messages, {
              id,
              role: 'assistant',
              parts: [{
                type: 'command',
                commandId: checkpoint.sourceCommandId,
                name: 'compact',
                args: null,
                outcome: null,
                compaction,
              }],
              ...base,
            }],
          }
        }
        return {
          messages: [...messages, {
            id: `compaction-${checkpoint.compactionId}`,
            role: 'assistant',
            parts: [compaction],
            ...base,
          }],
        }
      }
      // Other replacement copies are model-surface checkpoints, not new human transcript entries.
      if (ev.surfaceOp !== undefined && ev.surfaceOp !== 'append') return null
      const text = textOf(data)
      const images = imagePartsOf(data)
      if (!text && images.length === 0) return null
      const source = (data.source ?? {}) as Record<string, unknown>
      // 只有 source.kind === 'user' 是真实用户消息；其余（plugin、skill-catalog、
      // agent-instructions、session-reference…）是模型可见的上下文注入，折叠渲染。
      if (source.kind !== 'user') {
        const label = contextLabel(source)
        const msg: DshMessage = {
          id: `ctx-${ev.seq}`,
          role: 'assistant',
          parts: [{ type: 'context', label, text }],
          ...base,
        }
        return { messages: [...messages, msg] }
      }
      // 上游 steering 分类：只是 append surface 还不够——如果一个 user id 曾经被
      // next-step inbox 的 splice 移除（且 outcome != canceled）claim 过，这条
      // user/message 是「注入活跃 turn 的 steering」，不渲染为普通 user 气泡。
      const claimedId = String((data.id ?? data.messageId ?? data.rpcId) ?? '')
      if (claimed !== undefined && claimed.has(claimedId)) {
        const msg: DshMessage = {
          id: messageIdOf(data, `s-${ev.seq}`),
          role: 'steering',
          parts: [...(text ? [{ type: 'steering' as const, text }] : []), ...images],
          ...base,
        }
        return { messages: [...messages, msg] }
      }
      const msg: DshMessage = { id: messageIdOf(data, `u-${ev.seq}`), role: 'user', parts: [...(text ? [{ type: 'text' as const, text }] : []), ...images], ...base }
      if (msg.parts.length === 0) return null
      return { messages: [...messages, msg] }
    }
    case 'assistant/chunk': {
      const chunk = (data.chunk ?? {}) as Record<string, unknown>
      if (chunk.type === 'finish') {
        const reason = (chunk.reason ?? {}) as Record<string, unknown>
        if (reason.kind !== 'error') return { messages: withoutGenerationStatus(messages, data), isRunning: true }
        return {
          messages: upsertGenerationStatus(messages, data, base, {
            type: 'generation-status',
            state: 'error',
            title: 'Request failed',
            detail: failureDetail(reason.failure),
          }),
          isRunning: true,
        }
      }
      return { messages: applyAssistantChunk(withoutGenerationStatus(messages, data), data, base), isRunning: true }
    }
    case 'llm/retry': {
      const retry = typeof data.retry === 'number' ? data.retry : undefined
      const maxRetries = typeof data.maxRetries === 'number' ? data.maxRetries : undefined
      const progress = retry === undefined ? '' : maxRetries === undefined ? `Attempt ${retry}` : `Attempt ${retry} of ${maxRetries}`
      return {
        messages: upsertGenerationStatus(messages, data, base, {
          type: 'generation-status',
          state: 'retrying',
          title: 'Retrying request',
          detail: [progress, failureDetail(data.failure)].filter(Boolean).join(' - '),
          ...(retry === undefined ? {} : { retry }),
          ...(maxRetries === undefined ? {} : { maxRetries }),
        }),
        isRunning: true,
      }
    }
    case 'llm/retry-started': {
      const id = generationStatusId(data)
      const existing = messages.find((message) => message.id === id)
      if (!existing) return { messages, isRunning: true }
      return {
        messages: upsertGenerationStatus(messages, data, base, {
          type: 'generation-status',
          state: 'retrying',
          title: 'Retrying request',
          detail: existing.parts[0]?.type === 'generation-status' ? existing.parts[0].detail : 'Starting another attempt.',
          ...(typeof data.retry === 'number' ? { retry: data.retry } : {}),
        }),
        isRunning: true,
      }
    }
    case 'assistant/message': {
      if (ev.surfaceOp !== undefined && ev.surfaceOp !== 'append') return null
      const parts = [...assistantPartsOf(data), ...imagePartsOf(data)]
      // assistant/message can be an intermediate step before another tool call;
      // only turn/end or host/session-status is authoritative for completion.
      if (parts.length === 0) return { messages }
      return { messages: finalizedAssistantMessage(messages, data, base, parts) }
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
      const message = (data.message ?? {}) as Record<string, unknown>
      const firstPart = (Array.isArray(message.content) ? message.content[0] : {}) as Record<string, unknown>
      const callId = String(firstPart.toolCallId ?? data.callId ?? '')
      if (!callId) return null
      const isError = firstPart.isError === true || data.isError === true || firstPart.error !== undefined || data.error !== undefined
      const result = firstPart.content ?? data.result ?? data.output ?? {}
      const error = firstPart.error ?? data.error
      const idx = messages.findIndex((m) => m.id === callId)
      if (idx === -1) {
        const toolName = String(firstPart.name ?? data.name ?? data.toolName ?? 'tool')
        const toolPart: DshMessagePart = {
          type: 'tool', toolName, callId,
          args: firstPart.arguments ?? data.arguments ?? data.args ?? {},
          result,
          ...(firstPart.isError !== undefined || data.isError !== undefined ? { isError: firstPart.isError === true || data.isError === true } : {}),
          ...(error !== undefined ? { error } : {}),
          status: isError ? 'error' : 'complete',
        }
        return { messages: [...messages, { id: callId, role: 'assistant', parts: [toolPart], ...base }] }
      }
      const next = [...messages]
      const target = next[idx]!
      next[idx] = {
        ...target,
        parts: target.parts.map((p) =>
          p.type === 'tool' && p.callId === callId
            ? { ...p, status: isError ? 'error' as const : 'complete' as const, result, ...(firstPart.isError !== undefined || data.isError !== undefined ? { isError: firstPart.isError === true || data.isError === true } : {}), ...(error !== undefined ? { error } : {}) }
            : p,
        ),
      }
      return { messages: next }
    }
    case 'turn/start':
      return { messages, isRunning: true }
    case 'turn/end':
      return { messages, isRunning: false }
    case 'command/run': {
      const commandId = String(data.commandId ?? `c-${ev.seq}`)
      const msg: DshMessage = {
        id: `cmd-${commandId}`,
        role: 'assistant',
        parts: [{
          type: 'command',
          commandId,
          name: typeof data.name === 'string' ? data.name : null,
          args: typeof data.args === 'string' ? data.args : null,
          outcome: null,
        }],
        ...base,
      }
      const existing = messages.findIndex((message) => message.id === msg.id)
      if (existing < 0) return { messages: [...messages, msg] }
      const next = [...messages]
      next[existing] = msg
      return { messages: next }
    }
    case 'command/done': {
      const commandId = String(data.commandId ?? `c-${ev.seq}`)
      const id = `cmd-${commandId}`
      const existingIndex = messages.findIndex((message) => message.id === id)
      const existing = existingIndex < 0 ? undefined : messages[existingIndex]
      const previous = existing?.parts.find((part) => part.type === 'command')
      const sourceEventSeq = typeof data.sourceEventSeq === 'number' && Number.isSafeInteger(data.sourceEventSeq) && data.sourceEventSeq >= 0
        ? data.sourceEventSeq
        : undefined
      const command: DshMessagePart = {
        type: 'command',
        commandId,
        name: previous?.type === 'command' ? previous.name : null,
        args: previous?.type === 'command' ? previous.args : null,
        outcome: {
          kind: data.kind === 'error' ? 'error' : 'success',
          ...(typeof data.text === 'string' ? { text: data.text } : {}),
          ...(sourceEventSeq === undefined ? {} : { sourceEventSeq }),
        },
      }
      const msg: DshMessage = {
        id,
        role: 'assistant',
        parts: [{
          ...command,
          ...(previous?.type === 'command' && previous.compaction !== undefined
            ? { compaction: previous.compaction }
            : {}),
        }],
        seq: existing?.seq ?? ev.seq,
        createdAt: existing?.createdAt ?? ev.time,
      }
      if (existingIndex < 0) return { messages: [...messages, msg] }
      const next = [...messages]
      next[existingIndex] = msg
      return { messages: next }
    }
    default:
      // compaction、steering 等：骨架阶段忽略。
      return null
  }
}

/** next-step inbox 累积状态（上游 InboxState 的本地等价）：pending 队列 + claimed 集合。 */
export interface InboxFoldState {
  readonly pending: readonly { readonly id: string }[]
  readonly claimed: ReadonlySet<string>
}

interface InboxSpliceRecord {
  target?: unknown
  start?: unknown
  removedCount?: unknown
  inserted?: unknown
  outcome?: unknown
}

/** 应用一次 agent/inbox/spliced（上游 inbox.ts applySplice）：
 *  - removed 从 pending 移除、inserted 原位插入；
 *  - inserted 的 id 从 claimed 清除（被重新入队 = 不再是本步已 claim 的输入）；
 *  - target=next-step 且 outcome != canceled 时，removed 的 id 加入 claimed。
 *  只维护 next-step 的 pending/claimed（steering 判定唯一依赖它），其余 target 忽略。 */
function applyInboxSplice(previous: InboxFoldState | undefined, data: unknown): InboxFoldState {
  const pending = [...(previous?.pending ?? [])]
  const claimed = new Set(previous?.claimed)
  const splice = (data ?? {}) as InboxSpliceRecord
  if (splice.target !== 'next-step') return { pending, claimed }
  const start = typeof splice.start === 'number' && splice.start >= 0 ? splice.start : pending.length
  const removedCount = typeof splice.removedCount === 'number' && splice.removedCount >= 0 ? splice.removedCount : 0
  const inserted = Array.isArray(splice.inserted)
    ? splice.inserted.filter((item): item is { readonly id: string } => {
      if (typeof item !== 'object' || item === null) return false
      return typeof (item as { id?: unknown }).id === 'string'
    })
    : []
  const removed = pending.splice(start, removedCount, ...inserted)
  for (const identity of inserted) claimed.delete(identity.id)
  if (splice.outcome !== 'canceled') {
    for (const identity of removed) claimed.add(identity.id)
  }
  return { pending, claimed }
}

/** 会话级状态化 fold：把事件流折成 DshMessage[]，同时维护 next-step inbox 的
 *  pending/claimed 用于 steering 分类，并按 seq 去重（history 重放与 live 增量共用
 *  同一状态，steering 判定一致）。
 *
 *  每个 session 一个实例：openSession 新建 / removeSessionState 清理 / reopen 重建，
 *  不使用模块级共享可变状态，避免 session 间与测试间互相污染。 */
export class ConversationFold {
  private messages: DshMessage[] = []
  private inbox: InboxFoldState = { pending: [], claimed: new Set() }
  private compactionSummaries = new Map<string, CompactionSummaryData>()
  private seen = new Set<number>()
  private lastFoldedSeq = -1

  /** 当前 next-step inbox 状态（claimed 用于 steering 判定）。 */
  get inboxState(): Readonly<InboxFoldState> {
    return this.inbox
  }

  /** 已 fold 的最大事件 seq（未 fold 任何事件时为 -1）。 */
  get lastSeq(): number {
    return this.lastFoldedSeq
  }

  getMessages(): DshMessage[] {
    return this.messages
  }

  /** 用外部替换的消息列表（如 image hydration 后的副本）回写内部基线，
   *  后续 fold 从该列表继续，避免重复 hydration。 */
  applyMessages(messages: DshMessage[]): void {
    this.messages = messages
  }

  /** 折入一条事件（按 seq 去重；重复事件返回 null 且不改变状态）。 */
  fold(ev: FoldableSessionEvent): { messages: DshMessage[]; isRunning?: boolean } | null {
    if (this.seen.has(ev.seq)) return null
    this.seen.add(ev.seq)
    if (ev.seq > this.lastFoldedSeq) this.lastFoldedSeq = ev.seq
    if (ev.type === 'agent/inbox/spliced') {
      this.inbox = applyInboxSplice(this.inbox, ev.data)
      return null
    }
    const folded = foldEvent(this.messages, ev, this.inbox.claimed, this.compactionSummaries)
    if (!folded) return null
    this.messages = folded.messages
    return {
      messages: this.messages,
      ...(folded.isRunning === undefined ? {} : { isRunning: folded.isRunning }),
    }
  }
}

/** 把历史事件列表组装为初始消息列表（按 seq 升序 fold、按 seq 去重）。
 *  用独立 ConversationFold 实例重放，steering 分类与活更新一致。 */
export function foldHistory(events: FoldableSessionEvent[]): DshMessage[] {
  const folder = new ConversationFold()
  for (const ev of [...events].sort((left, right) => left.seq - right.seq)) folder.fold(ev)
  return folder.getMessages()
}
