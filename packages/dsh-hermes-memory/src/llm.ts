/**
 * dsh 进程内 LLM 补全助手 — 取代上游的 pi-child-process / review-memory-ops。
 *
 * 上游的 direct 传输走 pi-ai 的 completeSimple()；dsh 版走 `llm.stream()`
 * （当前 provider/model 由 agentDefaultModel 提供，可用 llmModelOverride 覆盖）。
 * dsh 无 pi 子进程路径，因此没有 subprocess 回退 — 失败直接返回结构化错误。
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MemoryConfig } from './types.ts'

/** 当前模型选择（agentDefaultModel.currentSelection() 的结构化子集）。 */
export interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: string
}

/** dsh llm 服务的结构化子集（便于测试注入）。 */
export interface LlmLike {
  stream(options: {
    provider: string
    model: string
    reasoningEffort?: string
    messages: unknown[]
    system?: string
    signal?: AbortSignal
  }): AsyncIterable<{ type: string; text?: string }>
}

/** timer 服务的结构化子集。 */
export interface TimerLike {
  timeout(callback: () => void, delay: number): () => void
}

/**
 * 解析模型覆盖：支持 "provider/model" 或裸模型 id（沿用当前 provider）。
 * @param config - 配置
 * @param current - 当前模型选择
 * @returns 解析后的选择；无法解析时回退当前选择
 */
export function resolveReviewModel(
  config: Pick<MemoryConfig, 'llmModelOverride'>,
  current: ModelSelection,
): ModelSelection {
  const override = config.llmModelOverride?.trim()
  if (!override) return current

  const slashIndex = override.indexOf('/')
  if (slashIndex !== -1) {
    const provider = override.slice(0, slashIndex).trim()
    const model = override.slice(slashIndex + 1).trim()
    if (provider && model) return { provider, model, reasoningEffort: current.reasoningEffort }
  }
  // 裸模型 id：沿用当前 provider。
  return { ...current, model: override }
}

/** 思考级别覆盖：设置了模型覆盖但未设置思考级别时默认 off。 */
export function effectiveThinkingOverride(
  config: Pick<MemoryConfig, 'llmModelOverride' | 'llmThinkingOverride'>,
): string | undefined {
  return config.llmThinkingOverride ?? (config.llmModelOverride?.trim() ? 'off' : undefined)
}

export interface CompleteTextOptions {
  llm: LlmLike
  selection: ModelSelection
  system: string
  user: string
  timeoutMs: number
  signal?: AbortSignal
  timer?: TimerLike
  reasoningEffort?: string
}

/**
 * 单轮文本补全（非流式拼接 text-delta）。
 * @param options - 补全选项
 * @returns 完整文本
 * @throws 超时、取消或 provider 错误
 */
export async function completeText(options: CompleteTextOptions): Promise<string> {
  const { llm, selection, system, user, timeoutMs, signal, timer, reasoningEffort } = options

  const controller = new AbortController()
  let disposeTimeout: (() => void) | undefined
  if (timer) {
    disposeTimeout = timer.timeout(() => controller.abort(), timeoutMs)
  } else {
    const handle = setTimeout(() => controller.abort(), timeoutMs)
    disposeTimeout = () => clearTimeout(handle)
  }
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', () => controller.abort(), { once: true })
  }

  try {
    const message = createUserMessage({
      content: [{ type: 'text', text: user }],
      source: { kind: 'plugin', plugin: 'dsh-hermes-memory' },
    })
    const stream = llm.stream({
      provider: selection.provider,
      model: selection.model,
      reasoningEffort: reasoningEffort ?? selection.reasoningEffort,
      messages: [message],
      system,
      signal: controller.signal,
    })

    let text = ''
    for await (const chunk of stream) {
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
        text += chunk.text
      }
    }
    return text
  } finally {
    disposeTimeout?.()
    signal?.removeEventListener('abort', () => controller.abort())
  }
}

/**
 * 提取 JSON 载荷：直接 JSON、围栏代码块或大括号切片。
 * @param text - 模型输出
 * @returns 解析结果；无法解析时返回 null
 */
export function extractJsonPayload(text: string): unknown {
  const trimmed = text.trim()
  if (!trimmed) return null

  try {
    return JSON.parse(trimmed)
  } catch {
    // continue
  }

  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim())
    } catch {
      // continue
    }
  }

  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1))
    } catch {
      return null
    }
  }

  return null
}
