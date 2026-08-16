/**
 * 后台 review — 每 N 轮自动保存记忆的学习循环。
 * 移植自 pi-hermes-memory/src/handlers/background-review.ts（MIT）。
 *
 * 差异：dsh 无 `pi.on('turn_end')`，改用 `session/event` 事件流计数
 * （turn/end、tool/result、user/message）；对话快照从 session.events 折叠。
 * 传输只有进程内 direct（llm.stream），无子进程回退。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  buildMemoryTargetRoutingGuidance,
  DIRECT_REVIEW_SYSTEM_PROMPT,
  ENTRY_DELIMITER,
} from '../constants.ts'
import type { HermesRuntime } from '../runtime.ts'
import { runMemoryCompletion } from './llm-run.ts'
import { collectSessionParts, isDirectUserMessage } from './session-util.ts'
import { isMinimalSessionPreset } from '../presets.ts'

/** 每会话的 review 计数状态。 */
interface ReviewState {
  turnsSinceReview: number
  toolCallsSinceReview: number
  userTurnCount: number
  reviewInProgress: boolean
}

function buildDirectReviewUserPrompt(
  parts: string[],
  currentMemory: string,
  currentUser: string,
  currentProject: string | null,
): string {
  const sections = [
    '--- Current Memory ---',
    currentMemory || '(empty)',
    '',
    '--- Current User Profile ---',
    currentUser || '(empty)',
  ]

  if (currentProject !== null) {
    sections.push(
      '',
      '--- Current Project Memory ---',
      currentProject || '(empty)',
    )
  }

  sections.push(
    '',
    '--- Conversation to Review ---',
    parts.join('\n\n'),
  )

  return sections.join('\n')
}

/**
 * 设置后台学习循环。
 * @param ctx - 插件上下文
 * @param runtime - 插件运行时
 * @param isDisabledSession - 判定「该会话禁用自动行为」的谓词（默认 minimal 预设）；
 *   为 true 的会话（如 minimal 双工具编码）不参与后台 review。
 */
export function setupBackgroundReview(
  ctx: Context,
  runtime: HermesRuntime,
  isDisabledSession: (session: Session) => boolean = isMinimalSessionPreset,
): void {
  const { config, store, projectStores } = runtime
  const states = new Map<string, ReviewState>()

  const stateFor = (sessionId: string): ReviewState => {
    let state = states.get(sessionId)
    if (!state) {
      state = { turnsSinceReview: 0, toolCallsSinceReview: 0, userTurnCount: 0, reviewInProgress: false }
      states.set(sessionId, state)
    }
    return state
  }

  const runReview = async (session: Session, state: ReviewState): Promise<void> => {
    const allParts = collectSessionParts(session, config.reviewRecentMessages)
    if (allParts.length < 4) return

    const cwd = session.header.cwd
    const project = projectStores.resolve(cwd)
    const promptInput = {
      parts: allParts,
      currentMemory: store.getMemoryEntries().join(ENTRY_DELIMITER),
      currentUser: store.getUserEntries().join(ENTRY_DELIMITER),
      currentProject: project.store ? project.store.getMemoryEntries().join(ENTRY_DELIMITER) : null,
    }

    if (!runtime.llm) {
      console.warn('[dsh-hermes-memory] Background review skipped: llm service is not mounted.')
      return
    }

    const result = await runMemoryCompletion(
      runtime.llm,
      runtime.defaultModel,
      runtime.timer,
      store,
      project.store,
      {
        userPrompt: buildDirectReviewUserPrompt(
          promptInput.parts,
          promptInput.currentMemory,
          promptInput.currentUser,
          promptInput.currentProject,
        ),
        systemPrompt: [
          DIRECT_REVIEW_SYSTEM_PROMPT,
          '',
          buildMemoryTargetRoutingGuidance(project.store !== null),
        ].join('\n'),
        config,
        timeoutMs: 120000,
      },
      project.name,
    )

    if (result.ok && result.appliedCount > 0) {
      console.info('[dsh-hermes-memory] 💾 Memory auto-reviewed and updated')
    } else if (!result.ok && result.fallbackReason && result.fallbackReason !== 'empty') {
      console.warn(
        `[dsh-hermes-memory] Memory auto-review failed: ${result.fallbackReason}${result.error ? `: ${result.error}` : ''}`,
      )
    }
  }

  ctx.on('session/event', (session, event) => {
    if (isDisabledSession(session)) return
    const state = stateFor(session.id)

    if (isDirectUserMessage(event as { type: string; data?: { source?: { kind?: string } } })) {
      state.userTurnCount++
      return
    }

    if (event.type === 'turn/end') {
      state.turnsSinceReview++
      if (!config.reviewEnabled || state.reviewInProgress) return
      if (state.userTurnCount < 3) return

      const turnThresholdMet = state.turnsSinceReview >= config.nudgeInterval
      const toolCallThresholdMet = state.toolCallsSinceReview >= config.nudgeToolCalls
      if (!turnThresholdMet && !toolCallThresholdMet) return

      state.turnsSinceReview = 0
      state.toolCallsSinceReview = 0
      state.reviewInProgress = true

      void runReview(session, state)
        .catch((error) => {
          console.warn(`[dsh-hermes-memory] Background review crashed: ${String(error)}`)
        })
        .finally(() => {
          state.reviewInProgress = false
        })
      return
    }

    if (event.type === 'tool/result') {
      state.toolCallsSinceReview++
    }
  })
}
