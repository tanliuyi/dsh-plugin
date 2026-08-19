export interface TerminalToolData {
  command: string
  lines: readonly string[]
  visibleCount: number
  done: boolean
  success: boolean
  exitCode?: number | null
}

const TERMINAL_TOOL_NAMES = new Set([
  'bash',
  'cmd',
  'fish',
  'powershell',
  'pwsh',
  'sh',
  'shell',
  'zsh',
])

/** Shell-like tool names rendered with the terminal element. */
export function isTerminalTool(toolName: string): boolean {
  return TERMINAL_TOOL_NAMES.has(toolName.trim().toLowerCase())
}

function parseJsonLayers(value: unknown): unknown {
  let current = value
  for (let depth = 0; depth < 3; depth += 1) {
    if (typeof current !== 'string') return current
    const text = current.trim()
    if (text === '') return current
    try {
      current = JSON.parse(text) as unknown
    } catch {
      return current
    }
  }
  return current
}

function recordOf(value: unknown): Record<string, unknown> {
  const parsed = parseJsonLayers(value)
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : {}
}

function stringField(source: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

function numberField(source: Record<string, unknown>, keys: readonly string[]): number | undefined {
  for (const key of keys) {
    const value = source[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

function joinOutput(values: readonly string[]): string {
  const present = values.filter((value) => value !== '')
  return present
    .map((value, index) => index < present.length - 1 ? value.replace(/\r?\n$/, '') : value)
    .join('\n')
}

/** Convert text content blocks and shell stream fields into terminal text. */
function outputTextOf(value: unknown, depth = 0): string {
  if (value === undefined || value === null || depth > 5) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)

  if (Array.isArray(value)) {
    return joinOutput(value.map((item) => outputTextOf(item, depth + 1)))
  }

  if (typeof value !== 'object') return ''
  const source = value as Record<string, unknown>

  if (source.type === 'text' && typeof source.text === 'string') return source.text

  const streamText = joinOutput(
    ['stdout', 'stderr'].map((key) => outputTextOf(source[key], depth + 1)),
  )
  if ('stdout' in source || 'stderr' in source) return streamText

  for (const key of ['output', 'text', 'message', 'content', 'result', 'value', 'error']) {
    const text = outputTextOf(source[key], depth + 1)
    if (text !== '') return text
  }

  if (['exitCode', 'exit_code', 'signal', 'timedOut', 'timeoutMs', 'aborted', 'sandbox']
    .some((key) => key in source)) {
    return ''
  }

  try {
    return JSON.stringify(value, null, 2) ?? ''
  } catch {
    return String(value)
  }
}

function linesOf(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (normalized === '') return []
  const lines = normalized.split('\n')
  if (lines.at(-1) === '') lines.pop()
  return lines
}

interface RenderedExitStatus {
  body: string
  exitCode?: number
  failed: boolean
}

/** Pull the bash/pwsh text renderer's exit marker into the terminal status pill. */
function renderedExitStatusOf(text: string): RenderedExitStatus {
  const body: string[] = []
  let exitCode: number | undefined
  let failed = false

  for (const line of linesOf(text)) {
    const exitMatch = /^\[exit code:\s*(-?\d+)\]$/.exec(line.trim())
    if (exitMatch) {
      exitCode = Number(exitMatch[1])
      failed ||= exitCode !== 0
      continue
    }
    if (/^\[(?:killed by signal|timed out after):/.test(line.trim())) {
      failed = true
      continue
    }
    body.push(line)
  }

  return { body: body.join('\n'), ...(exitCode === undefined ? {} : { exitCode }), failed }
}

function exitCodeOf(result: unknown): number | undefined {
  const source = recordOf(result)
  return numberField(source, ['exitCode', 'exit_code', 'statusCode', 'status_code'])
}

function hasErrorField(result: unknown): boolean {
  if (result === null || typeof result !== 'object' || Array.isArray(result)) return false
  const source = result as Record<string, unknown>
  return (source.error !== undefined && source.error !== null && source.error !== '')
    || source.isError === true
    || source.ok === false
}

/**
 * Adapt assistant-ui's tool-call payload into the assistant-ui Elements
 * TerminalBlock contract. The host has emitted both plain text and structured
 * content blocks over time, so the boundary intentionally accepts both.
 */
export function terminalToolDataOf(
  toolName: string,
  argsText: string | undefined,
  result: unknown,
  statusType?: string,
  isError = false,
): TerminalToolData | null {
  if (!isTerminalTool(toolName)) return null

  const parsedArgs = parseJsonLayers(argsText)
  const args = recordOf(parsedArgs)
  const command = stringField(args, ['command', 'cmd', 'script'])
    ?? (typeof parsedArgs === 'string' && parsedArgs.trim() !== '' ? parsedArgs : toolName)

  const resultRecord = recordOf(result)
  const output = outputTextOf(result)
  const rendered = renderedExitStatusOf(output)
  const lines = linesOf(rendered.body)
  const exitCode = exitCodeOf(result) ?? rendered.exitCode
  const running = statusType === 'running'
    || statusType === 'requires-action'
    || (statusType === undefined && result === undefined && !isError)
  const failed = isError
    || statusType === 'incomplete'
    || hasErrorField(result)
    || rendered.failed
    || (exitCode !== undefined && exitCode !== 0)

  // Some hosts put an error string beside an empty result object.
  if (lines.length === 0 && isError) {
    const errorText = outputTextOf(resultRecord.error)
    if (errorText !== '') lines.push(...linesOf(errorText))
  }

  return {
    command,
    lines,
    visibleCount: lines.length,
    done: !running,
    success: !failed,
    ...(exitCode === undefined ? {} : { exitCode }),
  }
}
