/**
 * 纠正检测 — 实时检测用户纠正并立即保存记忆（不等后台 review）。
 *
 * 两趟过滤：
 * - 强模式：命中即触发（高置信度）
 * - 弱模式：仅在后接指令性从句时触发
 * - 负模式：即使正模式命中也被抑制
 *
 * 移植自 pi-hermes-memory/src/handlers/correction-detector.ts（MIT）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  buildMemoryTargetRoutingGuidance,
  CORRECTION_DIRECTIVE_WORDS,
  CORRECTION_NEGATIVE_PATTERNS,
  CORRECTION_STRONG_PATTERNS,
  CORRECTION_WEAK_PATTERNS,
  DIRECT_CORRECTION_SYSTEM_PROMPT,
  ENTRY_DELIMITER,
} from '../constants.ts'
import type { MemoryConfig } from '../types.ts'
import { getMessageText } from '../types.ts'
import type { HermesRuntime } from '../runtime.ts'
import { runMemoryCompletion } from './llm-run.ts'
import { collectSessionParts, isDirectUserMessage } from './session-util.ts'
import { isMinimalSessionPreset } from '../presets.ts'

/**
 * 从纠正消息提取指令部分。
 * 例："no, use pnpm instead" -> "use pnpm instead"
 * @param text - 用户消息
 */
export function extractCorrectionDirective(text: string): string {
  // 去掉常见纠正开头
  const cleaned = text
    .replace(/^(no|wrong|actually|stop|don'?t|that'?s not|I said|I told you)[,\.\s!]+/i, '')
    .replace(/^(please\s+)?/i, '')
    .trim()
  return cleaned || text
}

function compileCorrectionPatterns(
  configured: string[] | undefined,
  defaults: RegExp[],
): RegExp[] {
  if (configured === undefined) return defaults

  const patterns: RegExp[] = []
  for (const source of configured) {
    try {
      patterns.push(new RegExp(source, 'i'))
    } catch {
      // 忽略无效的配置正则；有效条目仍然生效。
    }
  }
  return patterns
}

function escapeRegexLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function hasDirectiveWord(remainder: string, words: string[]): boolean {
  if (words.length === 0) return false
  const source = words.map(escapeRegexLiteral).join('|')
  return new RegExp(`\\b(${source})\\b`, 'i').test(remainder)
}

type CorrectionPatternConfig = Pick<MemoryConfig,
  'correctionStrongPatterns' |
  'correctionWeakPatterns' |
  'correctionNegativePatterns' |
  'correctionDirectiveWords'
>

/**
 * 判断用户消息是否为纠正（两趟过滤）。
 * @param text - 用户消息文本
 * @param config - 可覆盖的模式配置
 * @returns 是否应立即保存
 */
export function isCorrection(text: string, config?: CorrectionPatternConfig): boolean {
  const negativePatterns = compileCorrectionPatterns(
    config?.correctionNegativePatterns,
    CORRECTION_NEGATIVE_PATTERNS,
  )
  const strongPatterns = compileCorrectionPatterns(
    config?.correctionStrongPatterns,
    CORRECTION_STRONG_PATTERNS,
  )
  const weakPatterns = compileCorrectionPatterns(
    config?.correctionWeakPatterns,
    CORRECTION_WEAK_PATTERNS,
  )
  const directiveWords = config?.correctionDirectiveWords ?? CORRECTION_DIRECTIVE_WORDS

  // 先查负模式 — 即使正模式命中也被抑制
  for (const pattern of negativePatterns) {
    if (pattern.test(text)) return false
  }

  // 强模式 — 总是触发
  for (const pattern of strongPatterns) {
    if (pattern.test(text)) return true
  }

  // 弱模式 — 仅在后接指令性从句时触发
  for (const pattern of weakPatterns) {
    if (pattern.test(text)) {
      const match = pattern.exec(text)
      if (match && match.index === 0) {
        const remainder = text.slice(match[0].length).trim()
        if (hasDirectiveWord(remainder, directiveWords)) {
          return true
        }
      }
    }
  }

  return false
}

/** 每会话的纠正状态。 */
interface CorrectionState {
  pending: boolean
  turnsSinceLastCorrection: number
  correctionInProgress: boolean
}

/**
 * 设置纠正检测器。
 * @param ctx - 插件上下文
 * @param runtime - 插件运行时
 * @param isDisabledSession - 判定「该会话禁用自动行为」的谓词（默认 minimal 预设）。
 */
export function setupCorrectionDetector(
  ctx: Context,
  runtime: HermesRuntime,
  isDisabledSession: (session: Session) => boolean = isMinimalSessionPreset,
): void {
  if (!runtime.config.correctionDetection) return

  const { config, store, projectStores } = runtime
  const states = new Map<string, CorrectionState>()

  const stateFor = (sessionId: string): CorrectionState => {
    let state = states.get(sessionId)
    if (!state) {
      state = { pending: false, turnsSinceLastCorrection: 3, correctionInProgress: false }
      states.set(sessionId, state)
    }
    return state
  }

  ctx.on('session/event', (session, event) => {
    if (isDisabledSession(session)) return
    const state = stateFor(session.id)

    // user/message 时打标（仅真人消息）
    if (isDirectUserMessage(event as { type: string; data?: { source?: { kind?: string } } })) {
      const text = getMessageText((event as { data?: unknown }).data)
      if (text && isCorrection(text, config)) {
        state.pending = true
      }
      return
    }

    if (event.type !== 'turn/end') return
    if (!state.pending) {
      state.turnsSinceLastCorrection++
      return
    }
    state.pending = false

    // 限频：每 3 轮最多一次纠正保存
    if (state.turnsSinceLastCorrection < 3) return
    if (state.correctionInProgress) return

    state.turnsSinceLastCorrection = 0
    state.correctionInProgress = true

    void (async () => {
      try {
        const parts = collectSessionParts(session).slice(-6)
        const cwd = session.header.cwd
        const project = projectStores.resolve(cwd)
        const currentMemory = store.getMemoryEntries().join(ENTRY_DELIMITER)
        const currentUser = store.getUserEntries().join(ENTRY_DELIMITER)
        const currentProject = project.store ? project.store.getMemoryEntries().join(ENTRY_DELIMITER) : null

        const promptBody = [
          '--- Current Memory ---',
          currentMemory || '(empty)',
          '',
          '--- Current User Profile ---',
          currentUser || '(empty)',
        ]

        if (currentProject !== null) {
          promptBody.push(
            '',
            '--- Current Project Memory ---',
            currentProject || '(empty)',
          )
        }

        promptBody.push(
          '',
          '--- Recent Conversation ---',
          parts.join('\n\n'),
        )

        let savedViaLlm = false
        if (runtime.llm) {
          const directResult = await runMemoryCompletion(
            runtime.llm,
            runtime.defaultModel,
            runtime.timer,
            store,
            project.store,
            {
              systemPrompt: [
                DIRECT_CORRECTION_SYSTEM_PROMPT,
                '',
                buildMemoryTargetRoutingGuidance(project.store !== null),
              ].join('\n'),
              userPrompt: promptBody.join('\n'),
              config,
              timeoutMs: 30000,
            },
            project.name,
          )
          savedViaLlm = directResult.ok && directResult.appliedCount > 0
        }

        if (savedViaLlm) {
          console.info('[dsh-hermes-memory] 🔧 Correction detected — memory updated')
        }

        // 同时存为 failure 记忆（学习用）
        try {
          let lastUserMsg: string | undefined
          for (let i = parts.length - 1; i >= 0; i--) {
            if (parts[i]!.startsWith('[USER]')) {
              lastUserMsg = parts[i]
              break
            }
          }
          const correctionText = lastUserMsg ? lastUserMsg.replace(/^\[USER\]:\s*/, '') : ''
          if (correctionText) {
            const directive = extractCorrectionDirective(correctionText)
            await store.addFailure(directive, {
              category: 'correction',
              failureReason: 'User corrected the agent',
              project: project.store ? project.name ?? undefined : undefined,
            })
          }
        } catch {
          // 尽力而为 — 不阻塞会话
        }
      } catch {
        // 尽力而为 — 不阻塞会话
      } finally {
        state.correctionInProgress = false
      }
    })()
  })
}
