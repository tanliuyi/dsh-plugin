/**
 * 提示词上下文 — 记忆策略与常驻指令。
 * 移植自 pi-hermes-memory/src/prompt-context.ts（MIT）。
 */

import { MEMORY_POLICY_PROMPT, MEMORY_POLICY_PROMPT_COMPACT } from './constants.ts'
import type { MemoryConfig } from './types.ts'
import type { MemoryStore } from './store/memory-store.ts'
import type { StandingInstructions } from './store/standing-instructions.ts'

type MemoryPolicyConfig = Pick<MemoryConfig, 'memoryPolicyStyle' | 'memoryPolicyCustomText'>

/**
 * 解析记忆策略提示词（按风格）。
 * @param config - 策略配置
 */
export function resolveMemoryPolicyPrompt(config: MemoryPolicyConfig): string {
  const style = config.memoryPolicyStyle ?? 'full'

  switch (style) {
    case 'compact':
      return MEMORY_POLICY_PROMPT_COMPACT
    case 'custom':
      return config.memoryPolicyCustomText && config.memoryPolicyCustomText.trim().length > 0
        ? config.memoryPolicyCustomText
        : MEMORY_POLICY_PROMPT_COMPACT
    case 'none':
      return ''
    case 'full':
    default:
      return MEMORY_POLICY_PROMPT
  }
}

/**
 * 常驻指令在 *每种* 模式下都追加，包括 policy-only 与策略风格 "none"。
 * 这正是独立存储的意义：用户钉的规则不能依赖模型在禁令行动之前决定
 * 调用 memory_search（#121）。它们放最后，读起来像操作指令而不是回忆上下文。
 * @param config - 记忆模式配置
 * @param store - 全局存储
 * @param projectStore - 项目存储
 * @param projectName - 项目名
 * @param standing - 常驻指令
 */
export async function buildPromptContext(
  config: Pick<MemoryConfig, 'memoryMode' | 'memoryPolicyStyle' | 'memoryPolicyCustomText'>,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  projectName: string,
  standing: StandingInstructions | null = null,
): Promise<string> {
  const standingBlock = standing?.formatForSystemPrompt() ?? ''

  if (config.memoryMode === 'policy-only') {
    return [resolveMemoryPolicyPrompt(config), standingBlock].filter(Boolean).join('\n\n')
  }

  const memoryBlock = store.formatForSystemPrompt()
  const projectBlock = projectStore ? projectStore.formatProjectBlock(projectName) : ''

  const parts: string[] = []
  if (memoryBlock) parts.push(memoryBlock)
  if (projectBlock) parts.push(projectBlock)
  if (standingBlock) parts.push(standingBlock)

  return parts.join('\n\n')
}
