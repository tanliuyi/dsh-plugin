/**
 * YAML frontmatter 解析（移植自 pi-subagents，MIT）。
 * 处理扁平 `key: value` 与嵌套块值（块标量 `>` / `|`，缩进块）。
 * 块值保留相对缩进，序列化时可恢复。
 */

import { escapeRegExp } from '../util.ts'

/**
 * Fold 一个 YAML folded 块标量：保留更缩进行与空行分隔。
 */
export function foldBlock(block: string): string {
  let folded = ''
  let hasContent = false
  let previousIsMoreIndented = false
  let blankLines = 0

  for (const line of block.split('\n')) {
    const current = line.trimEnd()
    if (current.trim() === '') {
      if (hasContent) blankLines++
      continue
    }
    const currentIsMoreIndented = current.length > current.trimStart().length
    if (hasContent) {
      if (blankLines > 0) {
        folded += '\n'.repeat(blankLines + (previousIsMoreIndented || currentIsMoreIndented ? 1 : 0))
      } else {
        folded += previousIsMoreIndented || currentIsMoreIndented ? '\n' : ' '
      }
    }
    folded += current
    hasContent = true
    previousIsMoreIndented = currentIsMoreIndented
    blankLines = 0
  }
  return folded.trim()
}

/**
 * 规范化简单标量列表字段：逗号分隔或块列表（`- item`）。
 */
export function parseFrontmatterList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined
  return raw
    .split('\n')
    .flatMap((line) => {
      const value = line.trim()
      const listItem = value.match(/^-\s+(.+)$/)
      return (listItem?.[1] ?? value).split(',')
    })
    .map((value) => value.trim())
    .filter(Boolean)
}

/**
 * 解析 YAML frontmatter（agent/chain 文件）。
 * 返回 frontmatter 映射与正文（frontmatter 之后的内容）。
 */
export function parseFrontmatter(content: string): { frontmatter: Record<string, string>; body: string } {
  const frontmatter: Record<string, string> = {}
  const normalized = content.replace(/\r\n/g, '\n')

  if (!normalized.startsWith('---')) {
    return { frontmatter, body: normalized }
  }

  const endIndex = normalized.indexOf('\n---', 3)
  if (endIndex === -1) {
    return { frontmatter, body: normalized }
  }

  const frontmatterBlock = normalized.slice(4, endIndex)
  const body = normalized.slice(endIndex + 4).trim()

  const lines = frontmatterBlock.split('\n')
  let currentKey: string | null = null
  let currentBlockLines: string[] | null = null
  let currentIndent: number | null = null
  let currentFolded = false
  let currentLiteral = false

  const flush = (): void => {
    if (currentKey === null || currentBlockLines === null) return
    const rawBlock = currentBlockLines.join('\n')
    const leadingSpaces = rawBlock.match(/^[ \t]+(?=\S)/m)
    const prefix = leadingSpaces?.[0] ?? ''
    const stripped = prefix
      ? rawBlock.replace(new RegExp(`^${escapeRegExp(prefix)}`, 'gm'), '').replace(/^\n/, '')
      : rawBlock
    frontmatter[currentKey] = currentFolded ? foldBlock(stripped) : stripped
    currentKey = null
    currentBlockLines = null
    currentIndent = null
    currentFolded = false
    currentLiteral = false
  }

  for (const line of lines) {
    const indent = line.search(/\S|$/)
    const trimmed = line.trim()

    if (currentKey !== null && currentBlockLines !== null && (indent > (currentIndent ?? 0) || ((currentFolded || currentLiteral) && trimmed === ''))) {
      currentBlockLines.push(line)
      continue
    }

    flush()

    const match = line.match(/^([\w-]+):\s*(.*)$/)
    if (match) {
      const [, key, rawValueValue] = match
      if (key === undefined || rawValueValue === undefined) continue
      const rawValue = rawValueValue.trim()
      const isQuoted = (rawValue.startsWith('"') && rawValue.endsWith('"')) || (rawValue.startsWith("'") && rawValue.endsWith("'"))
      const value = isQuoted ? rawValue.slice(1, -1) : rawValue
      const isFolded = !isQuoted && (rawValue === '>' || rawValue === '>-')
      const isLiteral = !isQuoted && (rawValue === '|' || rawValue === '|-')

      if (value === '' || isFolded || isLiteral) {
        currentKey = key
        currentBlockLines = []
        currentIndent = indent
        currentFolded = isFolded
        currentLiteral = isLiteral
      } else {
        frontmatter[key] = value
      }
    }
  }

  flush()
  return { frontmatter, body }
}

/** 把解析出的 frontmatter 字符串值规范为可选字符串（false/空 → undefined）。 */
export function optionalString(value: string | undefined): string | undefined {
  if (value === undefined || value === '' || value === 'false') return undefined
  return value
}

/** 解析布尔字段。 */
export function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') return fallback
  return value === 'true' || value === '1'
}

/** 解析正整数字段。 */
export function parsePositiveInt(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined
}

/** 解析 JSON 对象字段（如 turnBudget、acceptance、memory）。 */
export function parseJsonField(value: string | undefined): Record<string, unknown> | undefined {
  if (value === undefined || value === '') return undefined
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}

/**
 * 把 AgentConfig 序列化为 markdown 文件（管理动作 create/update/eject 使用）。
 */
export function serializeAgentFile(frontmatter: Record<string, unknown>, body: string): string {
  const lines: string[] = ['---']
  for (const [key, value] of Object.entries(frontmatter)) {
    if (value === undefined || value === false) continue
    if (Array.isArray(value)) {
      if (value.length === 0) {
        lines.push(`${key}:`)
      } else {
        lines.push(`${key}:`)
        for (const item of value) lines.push(`  - ${item}`)
      }
    } else if (typeof value === 'object' && value !== null) {
      lines.push(`${key}:`)
      const json = JSON.stringify(value)
      const inner = json.replace(/\n/g, '\n  ')
      lines.push(`  ${inner}`)
    } else {
      lines.push(`${key}: ${String(value)}`)
    }
  }
  lines.push('---', '')
  if (body) lines.push(body)
  return lines.join('\n')
}
