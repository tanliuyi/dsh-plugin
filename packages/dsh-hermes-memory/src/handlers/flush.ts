/**
 * 会话 flush — 在上下文丢失前给 agent 一次保存记忆的机会。
 * 移植自 pi-hermes-memory/src/handlers/session-flush.ts（MIT）。
 *
 * 差异：dsh 无 `session_before_compact` / `session_shutdown` 钩子；
 * 本移植在 `compaction/start` 会话事件（压缩前）与 `agent/disposed`
 * （会话结束）时触发。传输只有进程内 direct。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  buildMemoryTargetRoutingGuidance,
  DIRECT_FLUSH_SYSTEM_PROMPT,
  ENTRY_DELIMITER,
} from '../constants.ts'
import type { HermesRuntime } from '../runtime.ts'
import { runMemoryCompletion } from './llm-run.ts'
import { collectSessionParts, isDirectUserMessage } from './session-util.ts'
import { isMinimalSessionPreset } from '../presets.ts'

/** 每会话 flush 状态。 */
interface FlushState {
  userTurnCount: number
  flushInProgress: boolean
}

/**
 * 设置会话 flush。
 * @param ctx - 插件上下文
 * @param runtime - 插件运行时
 * @param isDisabledSession - 判定「该会话禁用自动行为」的谓词（默认 minimal 预设）。
 */
export function setupSessionFlush(
  ctx: Context,
  runtime: HermesRuntime,
  isDisabledSession: (session: Session) => boolean = isMinimalSessionPreset,
): void {
  const { config, store, projectStores } = runtime
  const states = new Map<string, FlushState>()

  const stateFor = (sessionId: string): FlushState => {
    let state = states.get(sessionId)
    if (!state) {
      state = { userTurnCount: 0, flushInProgress: false }
      states.set(sessionId, state)
    }
    return state
  }

  const flush = async (session: Session, timeoutMs: number): Promise<void> => {
    const state = stateFor(session.id)
    if (state.flushInProgress) return
    if (state.userTurnCount < config.flushMinTurns) return
    if (!runtime.llm) return

    state.flushInProgress = true
    try {
      const parts = collectSessionParts(session, config.flushRecentMessages)
      const project = projectStores.resolve(session.header.cwd)

      const result = await runMemoryCompletion(
        runtime.llm,
        runtime.defaultModel,
        runtime.timer,
        store,
        project.store,
        {
          systemPrompt: [
            DIRECT_FLUSH_SYSTEM_PROMPT,
            '',
            buildMemoryTargetRoutingGuidance(project.store !== null),
          ].join('\n'),
          userPrompt: [
            '--- Current Memory ---',
            store.getMemoryEntries().join(ENTRY_DELIMITER) || '(empty)',
            '',
            '--- Current User Profile ---',
            store.getUserEntries().join(ENTRY_DELIMITER) || '(empty)',
            ...(project.store ? [
              '',
              '--- Current Project Memory ---',
              project.store.getMemoryEntries().join(ENTRY_DELIMITER) || '(empty)',
            ] : []),
            '',
            '--- Conversation ---',
            parts.join('\n\n'),
          ].join('\n'),
          config,
          timeoutMs,
        },
        project.name,
      )

      if (result.ok && result.appliedCount > 0) {
        console.info('[dsh-hermes-memory] 💾 Session flush saved memories')
      } else if (!result.ok && result.fallbackReason && result.fallbackReason !== 'empty') {
        console.warn(
          `[dsh-hermes-memory] Session flush failed: ${result.fallbackReason}${result.error ? `: ${result.error}` : ''}`,
        )
      }
    } catch {
      // 尽力而为 — 不阻塞压缩或关闭
    } finally {
      state.flushInProgress = false
    }
  }

  // 计数用户轮次 + 压缩前 flush（minimal 会话跳过）。
  ctx.on('session/event', (session, event) => {
    if (isDisabledSession(session)) return
    const state = stateFor(session.id)
    if (isDirectUserMessage(event as { type: string; data?: { source?: { kind?: string } } })) {
      state.userTurnCount++
      return
    }
    // compaction/start 由 dsh-compaction 合并进 SessionEventMap；类型未包含时
    // 用字符串比较（编译期不含 dsh-compaction 的类型增强）。
    if ((event as { type: string }).type === 'compaction/start' && config.flushOnCompact) {
      void flush(session, 30_000)
    }
  })

  // 会话结束 flush（agent 离开注册表时，日志仍可读；minimal 会话跳过）。
  ctx.on('agent/disposed', (payload) => {
    if (!config.flushOnShutdown) return
    const session = payload.agent.session
    if (isDisabledSession(session)) return
    void flush(session, 10_000)
  })
}
