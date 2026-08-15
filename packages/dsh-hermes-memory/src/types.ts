/**
 * 共享类型 — pi-hermes-memory（MIT）移植的 dsh 版。
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'

export type MemoryOverflowStrategy = 'auto-consolidate' | 'reject' | 'fifo-evict'

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

export interface MemoryConfig {
  /** 提示词记忆模式。默认: policy-only */
  memoryMode: 'policy-only' | 'legacy-inject'
  /** policy-only 模式下的策略提示词风格。默认: full */
  memoryPolicyStyle?: 'full' | 'compact' | 'custom' | 'none'
  /** memoryPolicyStyle 为 custom 时的自定义策略文本 */
  memoryPolicyCustomText?: string
  /** MEMORY.md（agent 笔记）最大字符数。默认: 5000 */
  memoryCharLimit: number
  /** USER.md（用户画像）最大字符数。默认: 5000 */
  userCharLimit: number
  /** 项目级 MEMORY.md 最大字符数。默认: 5000 */
  projectCharLimit: number
  /** 后台自动 review 的轮次间隔。默认: 10 */
  nudgeInterval: number
  /** 后台 review 纳入的最近消息数。0 = 全部。默认: 0 */
  reviewRecentMessages?: number
  /** 是否启用后台学习循环。默认: true */
  reviewEnabled: boolean
  /** 压缩前 flush 记忆。默认: true */
  flushOnCompact: boolean
  /** 会话关闭时 flush 记忆。默认: true */
  flushOnShutdown: boolean
  /** flush 触发前的最小用户轮次数。默认: 6 */
  flushMinTurns: number
  /** session flush 纳入的最近消息数。0 = 全部。默认: 0 */
  flushRecentMessages?: number
  /** 覆盖扩展存储目录。默认: $DSH_HOME/hermes-memory */
  memoryDir?: string
  /** 项目记忆目录（$DSH_HOME 下相对路径）。默认: "projects-memory" */
  projectsMemoryDir?: string
  /** 后台 LLM 调用的模型覆盖（"provider/model" 或模型 id）。默认: unset */
  llmModelOverride?: string
  /** 后台 LLM 调用的思考级别覆盖。默认: unset */
  llmThinkingOverride?: ThinkingLevel
  /** 记忆满时的策略。默认: auto-consolidate */
  memoryOverflowStrategy?: MemoryOverflowStrategy
  /** 溢出后自动整合前的墙钟宽限（毫秒）。默认: 180000 */
  overflowGraceMs?: number
  /** memoryOverflowStrategy 的旧别名。默认: true */
  autoConsolidate: boolean
  /** 检测用户纠正并立即保存记忆。默认: true */
  correctionDetection: boolean
  /** 覆盖强纠正正则源。缺省 = 默认；[] = 无。 */
  correctionStrongPatterns?: string[]
  /** 覆盖弱纠正正则源。缺省 = 默认；[] = 无。 */
  correctionWeakPatterns?: string[]
  /** 覆盖负纠正正则源。缺省 = 默认；[] = 无。 */
  correctionNegativePatterns?: string[]
  /** 覆盖弱模式后的指令词。缺省 = 默认；[] = 无。 */
  correctionDirectiveWords?: string[]
  /** 向系统提示注入近期失败记忆。默认: true */
  failureInjectionEnabled: boolean
  /** 注入失败记忆的最大天数。默认: 7 */
  failureInjectionMaxAgeDays: number
  /** 注入失败记忆的最大条数。默认: 5 */
  failureInjectionMaxEntries: number
  /** 触发后台 review 的工具调用数（与轮次数取或）。默认: 15 */
  nudgeToolCalls: number
  /** 整合运行的最大毫秒数（自动与手动一致）。默认: 180000 */
  consolidationTimeoutMs: number
  /** 记录失败的自动整合尝试到控制台。默认: true */
  autoConsolidationWarnOnFailure: boolean
  /** 向每个会话注入常驻 STANDING.md 指令。默认: true */
  standingInstructionsEnabled: boolean
}

export type MemoryCategory =
  | 'failure'
  | 'correction'
  | 'insight'
  | 'preference'
  | 'convention'
  | 'tool-quirk'

export type MemoryTarget = 'memory' | 'user' | 'failure'
export type ToolMemoryTarget = MemoryTarget | 'project'

export interface MemoryResult {
  success: boolean
  error?: string
  message?: string
  warning?: string
  warnings?: string[]
  target?: ToolMemoryTarget
  entries?: string[]
  usage?: string
  entry_count?: number
  evicted_entries?: string[]
  evicted_count?: number
  matches?: string[]
  /** replace/remove 发错目标时，包含 old_text 的目标列表。 */
  matching_targets?: ToolMemoryTarget[]
}

export interface MemoryMutationOperation {
  action: 'add' | 'replace' | 'remove'
  content?: string
  oldText?: string
  category?: MemoryCategory
  failureReason?: string
  project?: string
}

export interface ConsolidationResult {
  /** 整合是否成功 */
  consolidated: boolean
  /** 失败原因 */
  error?: string
  /**
   * 另一个会话已持有该目标的整合锁。不是故障 — 工作正在别处进行 —
   * 调用方应让用户稍后重试，而不是报告整合失败。
   */
  deferred?: boolean
}

export type SkillScope = 'global' | 'project'

export interface SkillIndex {
  /** 读写删操作使用的稳定 id */
  skillId: string
  /** global 或 project 作用域 */
  scope: SkillScope
  /** 磁盘文件名（通常是 SKILL.md） */
  fileName: string
  /** 技能文件绝对路径 */
  path: string
  /** 项目技能所属的项目名 */
  projectName?: string
  /** frontmatter 与目录名中的技能 slug */
  name: string
  /** 展示用可选标题 */
  displayName?: string
  /** 列表中的一句话描述 */
  description: string
  /** ISO 创建日期 */
  created: string
  /** ISO 最近更新日期 */
  updated: string
}

export interface SkillDocument extends SkillIndex {
  /** frontmatter 之后的完整 markdown 正文 */
  body: string
  /** 版本号 */
  version: number
}

export interface SkillResult {
  success: boolean
  error?: string
  message?: string
  fileName?: string
  skillId?: string
  scope?: SkillScope
  path?: string
  conflictType?: 'duplicate' | 'similar' | 'name-collision' | 'scope-conflict'
  similarSkillIds?: string[]
  suggestedAction?: 'patch' | 'update' | 'rename'
}

/**
 * 从会话消息中提取可展示文本（dsh ContentBlock 版）。
 * 接受任意值 — 对缺少 `content` 的非消息对象返回 null。
 * @param msg - 消息或任意载荷
 * @param maxLength - 截断长度
 * @returns 拼接后的文本（截断到 maxLength），无法提取时返回 null
 */
export function getMessageText(msg: unknown, maxLength = 500): string | null {
  if (typeof msg !== 'object' || msg === null) return null
  const { content } = msg as Record<string, unknown>

  if (typeof content === 'string') {
    return content.slice(0, maxLength)
  }
  if (Array.isArray(content)) {
    const blocks = content as ContentBlock[]
    const text = blocks
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    return text.length > 0 ? text.slice(0, maxLength) : null
  }
  return null
}
