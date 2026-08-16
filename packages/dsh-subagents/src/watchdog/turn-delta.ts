/**
 * 回合 delta 格式化（对齐上游 pi-subagents src/watchdog/turn-delta.ts），
 * 输入是 dsh 会话事件（user/message、assistant/message、tool/call、tool/result）。
 *
 * 语义与上游一致：评审看到的是「本回合模型做了什么」的摘要——助手文本/思考、
 * 工具调用参数（edit/write 载荷 redact）、工具结果（含 fs 工具附带的 diff），
 * 而不是原始 git diff。
 */

type ContentBlockLike = {
  type?: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
  args?: unknown
  arguments?: unknown
  content?: unknown
  error?: unknown
  isError?: boolean
  toolCallId?: string
}

function formatValue(value: unknown, indent = ''): string {
  if (typeof value === 'string') return value
  if (value === undefined) return 'undefined'
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return JSON.stringify(value)
  if (Array.isArray(value)) {
    return value.map((item, index) => `${indent}- ${formatValue(item, `${indent}  `)}`).join('\n')
  }
  if (typeof value === 'object') {
    const lines: string[] = []
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (typeof item === 'string' && item.includes('\n')) lines.push(`${indent}${key}:\n${item}`)
      else lines.push(`${indent}${key}: ${formatValue(item, `${indent}  `)}`)
    }
    return lines.join('\n')
  }
  return String(value)
}

function redactEditWriteInput(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(redactEditWriteInput)
  if (!input || typeof input !== 'object') return input
  const sanitized: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    sanitized[key] = ['oldText', 'newText', 'content'].includes(key) && typeof value === 'string'
      ? `[omitted ${value.length} chars; use tool result diff]`
      : redactEditWriteInput(value)
  }
  return sanitized
}

function formatToolArguments(name: string, input: unknown): string {
  if (name === 'edit' || name === 'write') return formatValue(redactEditWriteInput(input))
  return formatValue(input)
}

function formatToolCall(name: unknown, input: unknown): string {
  const toolName = typeof name === 'string' && name ? name : 'tool'
  return [`Tool call: ${toolName}`, 'Arguments:', formatToolArguments(toolName, input ?? {})].join('\n')
}

function formatToolResult(name: string, content: unknown, details: unknown, error: unknown, isError: boolean | undefined): string {
  const failed = isError === true || Boolean(error)
  const lines = [`Tool result: ${name}`]
  if (failed) lines.push(`Error: ${error ? (typeof error === 'string' ? error : formatValue(error)) : 'tool reported an error'}`)
  if (!failed && details && typeof details === 'object' && 'diff' in details && typeof (details as { diff?: unknown }).diff === 'string') {
    lines.push('Diff:', (details as { diff: string }).diff)
  } else {
    const body = textFromContent(content)
    if (body) lines.push(failed ? 'Output:' : 'Result:', body)
  }
  return lines.join('\n')
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((block) => {
      if (typeof block === 'string') return block
      if (block && typeof block === 'object') {
        const item = block as ContentBlockLike
        if (item.type === 'text' && typeof item.text === 'string') return item.text
        if (item.type === 'reasoning' && typeof item.thinking === 'string') return ['Thinking:', item.thinking].join('\n')
        if (item.type === 'tool-call') return formatToolCall(item.name, item.input ?? item.args ?? item.arguments)
        if (typeof item.content === 'string') return item.content
      }
      return ''
    }).filter(Boolean).join('\n')
  }
  if (content === undefined || content === null) return ''
  return formatValue(content)
}

/** 工具调用参数解析（原始 JSON 字符串）。 */
function parseToolArguments(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

export const REVIEW_DELTA_SEPARATOR = '\n\n---\n\n'

/**
 * 一个回合的 delta 累积器：运行时按会话事件喂入，turn/end 时 render() 产出
 * 评审输入的主文本（对齐上游「user prompt + 每步消息」的回合摘要形状）。
 */
export class WatchdogTurnAccumulator {
  private readonly sections: string[] = []
  private readonly toolNames = new Map<string, string>() // callId → toolName

  addUserPrompt(prompt: string): void {
    if (prompt.trim()) this.sections.push(['User prompt:', prompt].join('\n'))
  }

  addAssistantMessage(message: { content: unknown }): void {
    const content = message.content
    if (Array.isArray(content)) {
      for (const block of content) {
        if (!block || typeof block !== 'object') continue
        const item = block as ContentBlockLike
        if (item.type === 'text' && typeof item.text === 'string' && item.text.trim()) {
          this.sections.push(['Assistant:', item.text].join('\n'))
        } else if (item.type === 'reasoning' && typeof item.thinking === 'string' && item.thinking.trim()) {
          this.sections.push(['Thinking:', item.thinking].join('\n'))
        } else if (item.type === 'tool-call') {
          this.sections.push(formatToolCall(item.name, parseToolArguments(item.arguments ?? item.args ?? item.input)))
          if (typeof item.name === 'string' && typeof item.arguments === 'string') {
            // callId 未知：tool/call 事件会补登记
          }
        }
      }
    }
  }

  registerToolCall(callId: string, name: string): void {
    this.toolNames.set(callId, name)
  }

  addToolResult(callId: string, message: { content: unknown }, error: unknown, meta: unknown): void {
    const name = this.toolNames.get(callId) ?? 'tool'
    const block = Array.isArray(message.content) ? message.content.find((b): b is ContentBlockLike => typeof b === 'object' && b !== null && b.type === 'tool-result') : undefined
    const content = block?.content ?? message.content
    const isError = block?.isError === true || Boolean(error)
    const details = (meta && typeof meta === 'object' && 'diff' in (meta as Record<string, unknown>) && typeof (meta as Record<string, unknown>).diff === 'string')
      ? meta
      : undefined
    this.sections.push(formatToolResult(name, content, details, error ?? block?.error, isError))
  }

  render(): string {
    return this.sections.join(REVIEW_DELTA_SEPARATOR)
  }

  get isEmpty(): boolean {
    return this.sections.length === 0
  }
}
