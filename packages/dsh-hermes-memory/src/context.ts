/**
 * 系统提示段注册 — 记忆策略 + 常驻指令。
 *
 * 上游在 `before_agent_start` 把提示词追加到 systemPrompt；dsh 用
 * `systemPrompt.section()` 注册有序段：
 * - `hermes-memory:policy`（order 200，工具指引之后）— policy-only 模式注入
 *   <memory-policy>，legacy-inject 模式注入完整记忆块；
 * - `hermes-memory:standing`（order 9000，最后）— 常驻指令块，所有模式注入。
 *
 * 差异：legacy-inject 的项目记忆块不自动注入（dsh 的全局段没有会话 cwd 上下文，
 * 项目记忆通过 memory_search / memory_add target='project' 访问）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HermesRuntime } from './runtime.ts'
import { resolveMemoryPolicyPrompt } from './prompt-context.ts'

/** 记忆策略段名。 */
export const POLICY_SECTION = 'hermes-memory:policy'
/** 常驻指令段名。 */
export const STANDING_SECTION = 'hermes-memory:standing'

/**
 * 注册系统提示段。
 * @param ctx - 插件上下文
 * @param runtime - 插件运行时
 */
export function registerPromptSections(ctx: Context, runtime: HermesRuntime): void {
  const systemPrompt = ctx.get('systemPrompt') as {
    section(section: {
      name: string
      order: number
      text: string | ((context: unknown) => string)
    }): unknown
  } | undefined
  if (systemPrompt === undefined) return

  const { config, store, standing } = runtime

  if (config.memoryMode === 'policy-only') {
    systemPrompt.section({
      name: POLICY_SECTION,
      order: 200,
      text: resolveMemoryPolicyPrompt(config),
    })
  } else {
    systemPrompt.section({
      name: POLICY_SECTION,
      order: 200,
      text: () => store.formatForSystemPrompt(),
    })
  }

  if (standing && config.standingInstructionsEnabled !== false) {
    systemPrompt.section({
      name: STANDING_SECTION,
      order: 9000,
      text: () => standing.formatForSystemPrompt(),
    })
  }
}
