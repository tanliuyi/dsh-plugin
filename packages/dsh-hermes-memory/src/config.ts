/**
 * 插件配置 Schema 与默认值（port pi-hermes-memory 的 config.ts）。
 *
 * 上游从 `~/.pi/agent/hermes-memory-config.json` 加载配置；dsh 插件按
 * 仓库规范把配置声明为 Schemastery Schema，由 cordis.yml / cordis.patch.yml
 * 传入并在加载期校验。
 *
 * 未移植的上游字段（dsh 版无对应物，见 README 的差异说明）：
 * - `sessionSearch.variant`（dsh 的 session_search 统一走 sessionQuery）
 * - `reviewTransport`（dsh 只有进程内 direct 传输，无 pi 子进程）
 * - `childExtensionPaths`（子进程适配器白名单，dsh 无子进程路径）
 */

import Schema from '@deepseek-ai/schemastery'
import {
  DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS,
  DEFAULT_FAILURE_INJECTION_MAX_ENTRIES,
  DEFAULT_FLUSH_MIN_TURNS,
  DEFAULT_FLUSH_RECENT_MESSAGES,
  DEFAULT_MEMORY_CHAR_LIMIT,
  DEFAULT_NUDGE_INTERVAL,
  DEFAULT_NUDGE_TOOL_CALLS,
  DEFAULT_OVERFLOW_GRACE_MS,
  DEFAULT_PROJECT_CHAR_LIMIT,
  DEFAULT_PROJECTS_MEMORY_DIR,
  DEFAULT_REVIEW_RECENT_MESSAGES,
  DEFAULT_USER_CHAR_LIMIT,
} from './constants.ts'
import type { MemoryConfig, MemoryOverflowStrategy, ThinkingLevel } from './types.ts'

const MEMORY_OVERFLOW_STRATEGIES: readonly MemoryOverflowStrategy[] = ['auto-consolidate', 'reject', 'fifo-evict']
const THINKING_LEVELS: readonly ThinkingLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh']

/**
 * 插件配置（Schema 校验后的用户输入）。
 */
export interface Config extends MemoryConfig {}

/**
 * 插件配置 Schema：加载时校验并填充默认值。
 */
export const Config: Schema<Config> = Schema.object({
  /** 提示词记忆模式。 */
  memoryMode: Schema.union(['policy-only', 'legacy-inject']).default('policy-only'),
  /** 策略提示词风格（policy-only 模式）。 */
  memoryPolicyStyle: Schema.union(['full', 'compact', 'custom', 'none']).default('full'),
  /** 自定义策略文本（memoryPolicyStyle 为 custom 时使用）。 */
  memoryPolicyCustomText: Schema.string().default(''),
  /** MEMORY.md 最大字符数。 */
  memoryCharLimit: Schema.number().default(DEFAULT_MEMORY_CHAR_LIMIT),
  /** USER.md 最大字符数。 */
  userCharLimit: Schema.number().default(DEFAULT_USER_CHAR_LIMIT),
  /** 项目级 MEMORY.md 最大字符数。 */
  projectCharLimit: Schema.number().default(DEFAULT_PROJECT_CHAR_LIMIT),
  /** 后台自动 review 的轮次间隔。 */
  nudgeInterval: Schema.number().default(DEFAULT_NUDGE_INTERVAL),
  /** 后台 review 纳入的最近消息数（0 = 全部）。 */
  reviewRecentMessages: Schema.number().default(DEFAULT_REVIEW_RECENT_MESSAGES),
  /** 是否启用后台学习循环。 */
  reviewEnabled: Schema.boolean().default(true),
  /** 压缩前 flush 记忆。 */
  flushOnCompact: Schema.boolean().default(true),
  /** 会话关闭时 flush 记忆。 */
  flushOnShutdown: Schema.boolean().default(true),
  /** flush 触发前的最小用户轮次数。 */
  flushMinTurns: Schema.number().default(DEFAULT_FLUSH_MIN_TURNS),
  /** session flush 纳入的最近消息数（0 = 全部）。 */
  flushRecentMessages: Schema.number().default(DEFAULT_FLUSH_RECENT_MESSAGES),
  /** 覆盖扩展存储目录（绝对路径或 ~ 开头）。 */
  memoryDir: Schema.string().default(''),
  /** 项目记忆目录（$DSH_HOME 下的单段相对目录名）。 */
  projectsMemoryDir: Schema.string().default(DEFAULT_PROJECTS_MEMORY_DIR),
  /** 后台 LLM 调用的模型覆盖（"provider/model" 或模型 id）。 */
  llmModelOverride: Schema.string().default(''),
  /** 后台 LLM 调用的思考级别覆盖（可选）。 */
  llmThinkingOverride: Schema.union(THINKING_LEVELS),
  /** 记忆满时的策略。 */
  memoryOverflowStrategy: Schema.union(MEMORY_OVERFLOW_STRATEGIES).default('auto-consolidate'),
  /** 溢出后自动整合前的墙钟宽限（毫秒）。 */
  overflowGraceMs: Schema.number().default(DEFAULT_OVERFLOW_GRACE_MS),
  /** memoryOverflowStrategy 的旧别名（未显式设置 memoryOverflowStrategy 时由它决定）。 */
  autoConsolidate: Schema.boolean().default(true),
  /** 检测用户纠正并立即保存记忆。 */
  correctionDetection: Schema.boolean().default(true),
  /** 覆盖强纠正正则源。 */
  correctionStrongPatterns: Schema.array(Schema.string()).default([]),
  /** 覆盖弱纠正正则源。 */
  correctionWeakPatterns: Schema.array(Schema.string()).default([]),
  /** 覆盖负纠正正则源。 */
  correctionNegativePatterns: Schema.array(Schema.string()).default([]),
  /** 覆盖弱模式后的指令词。 */
  correctionDirectiveWords: Schema.array(Schema.string()).default([]),
  /** 向系统提示注入近期失败记忆（legacy-inject 模式）。 */
  failureInjectionEnabled: Schema.boolean().default(true),
  /** 注入失败记忆的最大天数。 */
  failureInjectionMaxAgeDays: Schema.number().default(DEFAULT_FAILURE_INJECTION_MAX_AGE_DAYS),
  /** 注入失败记忆的最大条数。 */
  failureInjectionMaxEntries: Schema.number().default(DEFAULT_FAILURE_INJECTION_MAX_ENTRIES),
  /** 触发后台 review 的工具调用数（与轮次数取或）。 */
  nudgeToolCalls: Schema.number().default(DEFAULT_NUDGE_TOOL_CALLS),
  /** 整合运行的最大毫秒数。 */
  consolidationTimeoutMs: Schema.number().default(DEFAULT_CONSOLIDATION_TIMEOUT_MS),
  /** 记录失败的自动整合尝试到控制台。 */
  autoConsolidationWarnOnFailure: Schema.boolean().default(true),
  /** 向每个会话注入常驻 STANDING.md 指令。 */
  standingInstructionsEnabled: Schema.boolean().default(true),
})

/**
 * 规范化 Schema 输出：把空字符串/空数组覆盖归一为 undefined，
 * 保持与上游 `llmModelOverride` 等"未设置"语义一致。
 * @param raw - Schema 校验后的原始值
 * @returns 规范化后的配置
 */
export function normalizeConfig(raw: Config): Config {
  const config: Config = { ...raw }
  if (!config.memoryPolicyCustomText?.trim()) delete config.memoryPolicyCustomText
  if (!config.memoryDir?.trim()) delete config.memoryDir
  if (!config.projectsMemoryDir?.trim()) delete config.projectsMemoryDir
  if (!config.llmModelOverride?.trim()) delete config.llmModelOverride
  if (!config.llmThinkingOverride) delete config.llmThinkingOverride
  if (config.correctionStrongPatterns?.length === 0) delete config.correctionStrongPatterns
  if (config.correctionWeakPatterns?.length === 0) delete config.correctionWeakPatterns
  if (config.correctionNegativePatterns?.length === 0) delete config.correctionNegativePatterns
  if (config.correctionDirectiveWords?.length === 0) delete config.correctionDirectiveWords
  // 旧别名回填：未显式设置 memoryOverflowStrategy 时由 autoConsolidate 决定。
  if (config.autoConsolidate === false && config.memoryOverflowStrategy === 'auto-consolidate') {
    config.memoryOverflowStrategy = 'reject'
  }
  return config
}
