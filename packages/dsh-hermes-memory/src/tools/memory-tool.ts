/**
 * 记忆写入工具 — 注册 memory_add / memory_replace / memory_remove。
 * 移植自 pi-hermes-memory/src/tools/memory-tool.ts（MIT）。
 *
 * 与上游的差异：Markdown → 搜索镜像的同步由 MemoryStore 的变异观察者完成
 * （见 runtime.ts / extended-store.ts），工具本身不再直接调用 SQLite 同步。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { lossless } from './lossless.ts'
import { MEMORY_TOOL_DESCRIPTION } from '../constants.ts'
import { normalizeMemoryLookupText } from '../store/memory-lookup.ts'
import type { HermesRuntime } from '../runtime.ts'
import type { MemoryCategory, MemoryResult, ToolMemoryTarget } from '../types.ts'

/** 工具返回的规范值（JSON）。 */
export interface MemoryToolOutput {
  success: boolean
  error?: string
  message?: string
  warning?: string
  warnings?: string[]
  target?: ToolMemoryTarget
  usage?: string
  entry_count?: number
  evicted_entries?: string[]
  evicted_count?: number
  matches?: string[]
  matching_targets?: ToolMemoryTarget[]
}

/** 渲染记忆工具结果文本。 */
export function formatMemoryToolText(result: MemoryToolOutput): string {
  const evictedEntries = result.evicted_entries ?? []
  if (result.success && evictedEntries.length > 0) {
    const lines = [
      result.message ?? `Memory updated. Rotated ${evictedEntries.length} older ${evictedEntries.length === 1 ? 'entry' : 'entries'} to stay within the limit.`,
      '',
      'Rotated active memory entries:',
      '',
    ]

    evictedEntries.forEach((entry, index) => {
      lines.push(`${index + 1}. ${entry}`)
      lines.push('')
    })

    lines.push('If one of these entries should stay active, add it again.')
    if (result.usage) lines.push(`Usage: ${result.usage}`)
    return lines.join('\n').trim()
  }

  return JSON.stringify(result)
}

function matchingMutationTargets(
  oldText: string,
  store: HermesRuntime['store'],
  projectStore: HermesRuntime['store'] | null,
): ToolMemoryTarget[] {
  const lookup = normalizeMemoryLookupText(oldText)
  if (!lookup) return []

  const targets: ToolMemoryTarget[] = []
  if (store.getMemoryEntries().some((entry) => entry.includes(lookup))) targets.push('memory')
  if (store.getUserEntries().some((entry) => entry.includes(lookup))) targets.push('user')
  if (store.getAllFailureEntries().some((entry) => entry.includes(lookup))) targets.push('failure')
  if (projectStore?.getMemoryEntries().some((entry) => entry.includes(lookup))) targets.push('project')
  return targets
}

function addWrongTargetHint(
  result: MemoryToolOutput,
  rawTarget: ToolMemoryTarget,
  oldText: string,
  store: HermesRuntime['store'],
  projectStore: HermesRuntime['store'] | null,
): MemoryToolOutput {
  if (result.success || !result.error?.startsWith('No entry matched')) return result

  const alternatives = matchingMutationTargets(oldText, store, projectStore)
    .filter((target) => target !== rawTarget)
  if (alternatives.length === 0) return result

  const quotedTargets = alternatives.map((target) => `"${target}"`).join(', ')
  const noun = alternatives.length === 1 ? 'target' : 'targets'
  return {
    ...result,
    error: `No match in target "${rawTarget}"; matching entry found in ${noun} ${quotedTargets}. Retry with the displayed target.`,
    matching_targets: alternatives,
  }
}

/** 记忆工具参数。 */
export interface MemoryToolArgs {
  target: ToolMemoryTarget
  content?: string
  old_text?: string
  category?: MemoryCategory
  failure_reason?: string
}

/** 从工具执行上下文解析 cwd。 */
export function cwdFromExec(exec: { agent?: { session?: { header?: { cwd?: string } } } }): string | undefined {
  return exec.agent?.session?.header?.cwd
}

/**
 * 注册三个记忆写入工具（memory_add / memory_replace / memory_remove）。
 * @param ctx - 插件上下文（ctx.tools 就绪）
 * @param runtime - 插件运行时
 */
export function registerMemoryTools(ctx: Context, runtime: HermesRuntime): void {
  const { store, projectStores } = runtime

  const executeAction = async (
    action: 'add' | 'replace' | 'remove',
    params: MemoryToolArgs,
    cwd: string | undefined,
    signal: AbortSignal | undefined,
  ): Promise<MemoryToolOutput> => {
    const { target: rawTarget, content, old_text, category, failure_reason } = params
    const target = rawTarget === 'project' ? 'memory' : rawTarget
    const project = rawTarget === 'project' ? projectStores.resolve(cwd) : { name: null, store: null }
    const activeStore = rawTarget === 'project' ? project.store : store

    if (rawTarget === 'project' && !activeStore) {
      return {
        success: false,
        error: 'Project memory is not available (no project detected).',
      }
    }

    let result: MemoryResult
    switch (action) {
      case 'add': {
        if (!content) {
          throw new Error('Content is required for \'add\' action.')
        }
        if (rawTarget === 'failure') {
          const memoryCategory = category ?? 'failure'
          result = await activeStore!.addFailure(content, {
            category: memoryCategory,
            failureReason: failure_reason,
          })
        } else {
          result = await activeStore!.add(target, content, signal)
        }
        break
      }
      case 'replace': {
        if (!old_text) throw new Error('old_text is required for \'replace\' action.')
        if (!content) throw new Error('content is required for \'replace\' action.')
        result = await activeStore!.replace(target, old_text, content)
        break
      }
      case 'remove': {
        if (!old_text) throw new Error('old_text is required for \'remove\' action.')
        result = await activeStore!.remove(target, old_text)
        break
      }
    }

    if (action !== 'add' && old_text) {
      result = addWrongTargetHint(result, rawTarget, old_text, store, project.store)
    }

    if (rawTarget === 'project' && result.success) result = { ...result, target: 'project' }

    return {
      success: result.success,
      error: result.error,
      message: result.message,
      warning: result.warning,
      warnings: result.warnings,
      target: result.target,
      usage: result.usage,
      entry_count: result.entry_count,
      evicted_entries: result.evicted_entries,
      evicted_count: result.evicted_count,
      matches: result.matches,
      matching_targets: result.matching_targets,
    }
  }

  const commonDescription = `${MEMORY_TOOL_DESCRIPTION}

This action-specific tool accepts only the parameters listed in its schema.`

  const render = (_args: unknown, value: unknown) => [
    { type: 'text' as const, text: formatMemoryToolText(value as MemoryToolOutput) },
  ]

  ctx.tools.register(defineTool({
    name: 'memory_add',
    description: `${commonDescription}

Add one durable entry. The target and content fields are required.`,
    parameters: {
      target: {
        type: 'string',
        enum: ['memory', 'user', 'project', 'failure'],
        required: true,
        description: 'Memory scope. Use failure for failures, corrections, insights, and tool quirks.',
      },
      content: { type: 'string', required: true, description: 'Entry content to save.' },
      category: {
        type: 'string',
        enum: ['failure', 'correction', 'insight', 'preference', 'convention', 'tool-quirk'],
        description: 'Category for failure memories.',
      },
      failure_reason: { type: 'string', description: 'Why a failure occurred.' },
    },
    output: {
      schema: { type: 'json' },
      render,
    },
    async execute(args, exec) {
      return lossless(await executeAction('add', args as MemoryToolArgs, cwdFromExec(exec), exec.signal)) 
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_replace',
    description: `${commonDescription}

Replace one existing entry. The target, old_text, and content fields are required.`,
    parameters: {
      target: {
        type: 'string',
        enum: ['memory', 'user', 'project', 'failure'],
        required: true,
        description: 'Memory scope. Use failure for failures, corrections, insights, and tool quirks.',
      },
      old_text: { type: 'string', required: true, description: 'Substring identifying the entry to replace.' },
      content: { type: 'string', required: true, description: 'Replacement entry content.' },
    },
    output: {
      schema: { type: 'json' },
      render,
    },
    async execute(args, exec) {
      return lossless(await executeAction('replace', args as MemoryToolArgs, cwdFromExec(exec), exec.signal)) 
    },
  }))

  ctx.tools.register(defineTool({
    name: 'memory_remove',
    description: `${commonDescription}

Remove one existing entry. The target and old_text fields are required.`,
    parameters: {
      target: {
        type: 'string',
        enum: ['memory', 'user', 'project', 'failure'],
        required: true,
        description: 'Memory scope. Use failure for failures, corrections, insights, and tool quirks.',
      },
      old_text: { type: 'string', required: true, description: 'Substring identifying the entry to remove.' },
    },
    output: {
      schema: { type: 'json' },
      render,
    },
    async execute(args, exec) {
      return lossless(await executeAction('remove', args as MemoryToolArgs, cwdFromExec(exec), exec.signal)) 
    },
  }))
}
