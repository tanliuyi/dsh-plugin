/**
 * LLM 驱动的记忆操作执行 — review/flush/correction/consolidation 共用。
 * 取代上游 review-memory-ops.ts 的 runDirectMemoryCompletion（pi-ai completeSimple
 * 版）；本移植走 dsh `llm.stream()` 进程内补全，无子进程回退。
 */

import type { MemoryConfig } from '../types.ts'
import type { MemoryStore } from '../store/memory-store.ts'
import {
  completeText,
  effectiveThinkingOverride,
  resolveReviewModel,
  type LlmLike,
  type ModelSelection,
  type TimerLike,
} from '../llm.ts'
import { applyReviewOperations, parseReviewOperations, type ReviewMemoryOperation } from './review-ops.ts'

export interface RunMemoryCompletionOptions {
  systemPrompt: string
  userPrompt: string
  config: Pick<MemoryConfig, 'llmModelOverride' | 'llmThinkingOverride'>
  timeoutMs?: number
  signal?: AbortSignal
  requireAtomicShrink?: boolean
  expectedTarget?: ReviewMemoryOperation['target']
}

export interface DirectReviewResult {
  ok: boolean
  appliedCount: number
  fallbackReason?: 'no_llm' | 'no_model' | 'aborted' | 'parse_error' | 'provider_error' | 'empty'
  error?: string
}

/**
 * 执行一轮进程内 LLM 记忆操作。
 * @param llm - llm 服务
 * @param defaultModel - 默认模型选择
 * @param timer - timer 服务
 * @param store - 全局存储
 * @param projectStore - 项目存储
 * @param options - 提示词与约束
 * @param projectName - 项目名
 */
export async function runMemoryCompletion(
  llm: LlmLike,
  defaultModel: (() => ModelSelection | undefined) | undefined,
  timer: TimerLike | undefined,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  options: RunMemoryCompletionOptions,
  projectName?: string | null,
): Promise<DirectReviewResult> {
  const current = defaultModel?.()
  if (!current) {
    return { ok: false, appliedCount: 0, fallbackReason: 'no_model' }
  }

  const selection = resolveReviewModel(options.config, current)
  const reasoningEffort = effectiveThinkingOverride(options.config)

  let text: string
  try {
    text = await completeText({
      llm,
      selection,
      system: options.systemPrompt,
      user: options.userPrompt,
      timeoutMs: options.timeoutMs ?? 120000,
      signal: options.signal,
      timer,
      reasoningEffort,
    })
  } catch (error) {
    if (options.signal?.aborted) {
      return { ok: false, appliedCount: 0, fallbackReason: 'aborted' }
    }
    return {
      ok: false,
      appliedCount: 0,
      fallbackReason: 'provider_error',
      error: error instanceof Error ? error.message : String(error),
    }
  }

  const operations = parseReviewOperations(text)
  if (operations === null) {
    return { ok: false, appliedCount: 0, fallbackReason: 'parse_error' }
  }
  if (operations.length === 0) {
    return { ok: true, appliedCount: 0, fallbackReason: 'empty' }
  }

  const applied = await applyReviewOperations(
    store,
    projectStore,
    operations,
    projectName,
    {
      requireAtomicShrink: options.requireAtomicShrink,
      expectedTarget: options.expectedTarget,
    },
  )
  if (applied.error) {
    return {
      ok: false,
      appliedCount: 0,
      fallbackReason: 'provider_error',
      error: applied.error,
    }
  }
  return { ok: true, appliedCount: applied.appliedCount }
}
