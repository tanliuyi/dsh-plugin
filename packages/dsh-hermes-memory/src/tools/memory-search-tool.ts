/**
 * memory_search 工具 — 搜索扩展记忆存储。
 * 移植自 pi-hermes-memory/src/tools/memory-search-tool.ts（MIT）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ExtendedMemoryEntry } from '../store/extended-store.ts'
import type { HermesRuntime } from '../runtime.ts'
import { lossless } from './lossless.ts'
import type { MemoryCategory, ToolMemoryTarget } from '../types.ts'

/** 工具返回的规范值。 */
export interface MemorySearchOutput {
  success: boolean
  count?: number
  message?: string
  output?: string
  results?: Array<{
    content: string
    target: ToolMemoryTarget
    project: string | null
    category?: MemoryCategory
    created: string
    lastReferenced: string
  }>
}

/** 把存储条目映射为变异目标（project 作用域的特殊映射）。 */
function mutationTarget(entry: ExtendedMemoryEntry): ToolMemoryTarget {
  return entry.target === 'memory' && entry.project ? 'project' : entry.target
}

function scopeLabel(project: string | null): string {
  return project ? `project:${encodeURIComponent(project)}` : 'global'
}

/** 渲染搜索输出文本。 */
export function formatMemorySearchOutput(output: MemorySearchOutput): string {
  if (!output.success) return output.message ?? 'Memory search failed.'
  if (output.count === 0) return output.message ?? 'No memories found.'
  return output.output ?? ''
}

/**
 * 注册 memory_search 工具。
 * @param ctx - 插件上下文
 * @param runtime - 插件运行时
 */
export function registerMemorySearchTool(ctx: Context, runtime: HermesRuntime): void {
  ctx.tools.register(defineTool({
    name: 'memory_search',
    description: `Search extended memory store for relevant entries. Use this when you need context beyond what's in the system prompt — the extended store has unlimited capacity and is searchable.

Use cases:
- Find memories about a specific topic: "What do I know about auth setup?"
- Search project-specific memories: "What conventions does project X follow?"
- Find user preferences: "What are the user's testing preferences?"
- Search for past failures: "memory_search('auth', category='failure')"

Returns matching memory entries with their mutation target, scope, and dates. The displayed target is the value required by memory_replace and memory_remove.`,
    parameters: {
      query: { type: 'string', required: true, description: 'Search query. Use natural language or specific terms.' },
      project: { type: 'string', description: 'Filter by project name. Pass null for global memories only.' },
      target: {
        type: 'string',
        enum: ['memory', 'user', 'failure'],
        description: 'Filter by target type (memory, user, or failure).',
      },
      category: {
        type: 'string',
        enum: ['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'],
        description: 'Filter by memory category.',
      },
      limit: { type: 'number', description: 'Maximum results to return (default: 10, max: 20).' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text' as const, text: formatMemorySearchOutput(value as unknown as MemorySearchOutput) }],
    },
    async execute(args) {
      const { query, project, target, category, limit } = args as {
        query: string
        project?: string
        target?: string
        category?: string
        limit?: number
      }
      const resolvedLimit = Math.min(limit || 10, 20)

      if (!query || query.trim().length === 0) {
        return lossless({ success: false, message: 'query is required' })
      }

      const stats = runtime.extended.getStats()
      if (stats.total === 0) {
        return lossless({ success: false, message: 'No memories in extended store yet. Use memory_add to store memories.' })
      }

      const results = runtime.extended.search(query, {
        project,
        target,
        category,
        limit: resolvedLimit,
      })

      if (results.length === 0) {
        return {
          success: true,
          count: 0,
          message: `No memories found matching "${query}". Try a different search term or broader query.`,
        }
      }

      let output = `Found ${results.length} memories matching "${query}":\n\n`

      const mapped: MemorySearchOutput['results'] = []
      for (const entry of results) {
        const entryTarget = mutationTarget(entry)
        const projectLabel = `scope=${scopeLabel(entry.project)}`
        const mutationTargetLabel = `[target=${entryTarget}]`
        const targetLabel = entry.target === 'user' ? '👤' : entry.target === 'failure' ? '⚠️' : '🧠'
        const categoryLabel = entry.category ? ` [${entry.category}]` : ''
        output += `${targetLabel} ${projectLabel} ${mutationTargetLabel}${categoryLabel} ${entry.content}\n`
        output += `   Created: ${entry.created} | Last used: ${entry.lastReferenced}\n\n`
        mapped.push({
          content: entry.content,
          target: entryTarget,
          project: entry.project,
          category: entry.category,
          created: entry.created,
          lastReferenced: entry.lastReferenced,
        })
      }

      return lossless({ success: true, count: results.length, output: output.trim(), results: mapped })
    },
  }))
}
