/**
 * Model fallback（对齐上游 pi-subagents src/runs/shared/model-fallback.ts）。
 *
 * 语义：primary + fallbackModels 构造成候选列表（去重），子代理启动/运行失败
 * 且错误可重试（rate limit / 模型不可用 / 网络等）时用下一个候选模型重试整
 * 个任务。dsh 侧无 availableModels 注册表，候选规范化复用 llm.ts 的
 * parseModelSpec；运行接线在 spawn.ts（模型尝试循环）。
 */

/** 上游 RETRYABLE_MODEL_FAILURE_PATTERNS 的可重试失败判定。 */
const RETRYABLE_MODEL_FAILURE_PATTERNS = [
  /rate\s*limit/i,
  /too many requests/i,
  /\b429\b/,
  /quota/i,
  /billing/i,
  /credit/i,
  /auth(?:entication)?/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /api key/i,
  /token expired/i,
  /invalid key/i,
  /provider.*unavailable/i,
  /model.*unavailable/i,
  /model.*disabled/i,
  /model.*not found/i,
  /unknown model/i,
  /overloaded/i,
  /service unavailable/i,
  /temporar(?:ily)? unavailable/i,
  /connection refused/i,
  /fetch failed/i,
  /network error/i,
  /socket hang up/i,
  /stream ended without finish_reason/i,
  /upstream/i,
  /timed? out/i,
  /timeout/i,
  /\b502\b/,
  /\b503\b/,
  /\b504\b/,
  /cold.?start/i,
  /empty response/i,
  /no output/i,
  /model.*(?:load|fail|error)/i,
]

/** 工具失败前缀（来自子代理任务内工具调用，换模型无济于事）——对齐上游排除。 */
const TOOL_FAILURE_PREFIX = /^[\w.:@/-]+ failed (?:(?:\(exit \d+\):)|(?:with exit code \d+))(?:\s|$)/i

/** 失败是否值得换模型重试（对齐上游 isRetryableModelFailure）。 */
export function isRetryableModelFailure(error: string | undefined): boolean {
  if (!error) return false
  if (TOOL_FAILURE_PREFIX.test(error.trim())) return false
  return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(error))
}

/** 从错误对象提取诊断文本。 */
export function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return String(error)
}

/** 构建候选模型列表（primary + fallbacks 去重、去除空项）。 */
export function buildModelCandidates(primaryModel: string | undefined, fallbackModels: string[] | undefined): string[] {
  const seen = new Set<string>()
  const candidates: string[] = []
  for (const raw of [primaryModel, ...(fallbackModels ?? [])]) {
    if (!raw) continue
    const trimmed = raw.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    candidates.push(trimmed)
  }
  return candidates
}

/** 模型尝试记录（对齐上游 ModelAttemptSummary）。 */
export interface ModelAttemptSummary {
  model: string
  success: boolean
  error?: string
}

/** 尝试失败/换模型的备注文案（对齐上游 formatModelAttemptNote）。 */
export function formatModelAttemptNote(attempt: ModelAttemptSummary, nextModel?: string): string {
  const failure = attempt.error?.trim() || 'exit 1'
  return nextModel
    ? `[fallback] ${attempt.model} failed: ${failure}. Retrying with ${nextModel}.`
    : `[fallback] ${attempt.model} failed: ${failure}.`
}
