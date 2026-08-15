/**
 * session_search 工具 — 搜索过去的会话。
 *
 * 移植自 pi-hermes-memory/src/tools/session-search-tool.ts（MIT）的 legacy
 * 变体。上游把 Pi 会话 JSONL 索引进自带 SQLite FTS5；dsh 的
 * `ctx.sessionQuery.searchSessions()` 已经提供跨会话全文检索（SQLite FTS，
 * 实时 + 持久化索引），本工具直接复用，不再维护第二份索引。
 * 上游的 `anchors` 变体（读 JSONL 原文返回行号锚点）不移植。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SessionSearchHit } from '@deepseek-ai/dsh-session-query'
import { lossless } from './lossless.ts'

/** 工具返回的规范值。 */
export interface SessionSearchOutput {
  success: boolean
  count?: number
  message?: string
  output?: string
  hits?: Array<{
    sessionId: string
    cwd?: string
    createdAt: number
    snippet: string
    seq: number
    time: number
  }>
}

const MAX_OUTPUT_CHARS = 50 * 1024

function capOutput(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  const suffix = '\n... (output truncated, refine the query or lower the result limit)'
  return `${text.slice(0, MAX_OUTPUT_CHARS - suffix.length)}${suffix}`
}

/** 渲染搜索输出文本。 */
export function formatSessionSearchOutput(output: SessionSearchOutput): string {
  if (!output.success) return output.message ?? 'Session search failed.'
  if (output.count === 0) return output.message ?? 'No sessions found.'
  return output.output ?? ''
}

/**
 * 注册 session_search 工具。
 * @param ctx - 插件上下文（ctx.sessionQuery 就绪）
 * @param getSessionQuery - 取 sessionQuery 服务的函数（判空）
 */
export function registerSessionSearchTool(
  ctx: Context,
  getSessionQuery: () => { searchSessions(request: { query: string; limit?: number; sessionFilters?: readonly unknown[]; eventFilters?: readonly unknown[]; cursor?: unknown }, exec?: { signal?: AbortSignal }): Promise<{ items: readonly SessionSearchHit[] }> } | undefined,
): void {
  ctx.tools.register(defineTool({
    name: 'session_search',
    description: `Search past conversations across all sessions. Use this when the current task depends on what was discussed or decided before.

Examples:
- "what did we discuss about auth?"
- "how did we fix the build error last week?"

Returns matching sessions with their strongest matching message excerpt.`,
    parameters: {
      query: { type: 'string', required: true, description: 'Search query. Use natural language or specific terms.' },
      limit: { type: 'number', description: 'Maximum sessions to return (default: 10, max: 20).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text' as const, text: formatSessionSearchOutput(value as unknown as SessionSearchOutput) }],
    },
    async execute(args, exec) {
      const { query, limit } = args as { query: string; limit?: number }
      const resolvedLimit = Math.min(limit || 10, 20)

      if (!query || query.trim().length === 0) {
        return lossless({ success: false, message: 'query is required' })
      }

      const sessionQuery = getSessionQuery()
      if (!sessionQuery) {
        return lossless({ success: false, message: 'Session search is unavailable (sessionQuery service not mounted).' })
      }

      let page
      try {
        page = await sessionQuery.searchSessions({ query, limit: resolvedLimit }, { signal: exec.signal })
      } catch (error) {
        return lossless({
          success: false,
          message: `Session search failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      }

      const hits = page.items
      if (hits.length === 0) {
        return {
          success: true,
          count: 0,
          message: `No sessions found matching "${query}". Try different terms or a broader query.`,
        }
      }

      let output = `Found ${hits.length} sessions matching "${query}":\n\n`
      const mapped: SessionSearchOutput['hits'] = []
      for (const hit of hits) {
        const sessionId = hit.header.id
        const cwd = hit.header.cwd
        const createdAt = hit.header.createdAt
        const snippet = hit.bestMatch.snippet
        const seq = hit.bestMatch.seq
        const time = hit.bestMatch.time
        output += `📄 ${sessionId}`
        if (cwd) output += ` (cwd: ${cwd})`
        output += `\n   ${snippet.slice(0, 300)}${snippet.length > 300 ? '…' : ''}\n\n`
        mapped.push({ sessionId, cwd, createdAt, snippet, seq, time })
      }

      const trimmed = capOutput(output.trim())
      return lossless({ success: true, count: hits.length, output: trimmed, hits: mapped })
    },
  }))
}
