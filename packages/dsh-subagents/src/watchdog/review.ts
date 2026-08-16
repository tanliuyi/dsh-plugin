/**
 * 评审 agent（对齐上游 pi-subagents src/watchdog/review.ts）。
 *
 * 平台适配：上游评审者是 pi-agent-core 的独立 Agent（只读工具 read/grep/find/ls +
 * watchdog_warn 工具、逐条 emission guard 反馈）。dsh 无独立 Agent 构造 API，
 * 因此评审者以「一次性只读子代理」运行（ctx.subagents.start，工具白名单 read/grep/glob，
 * dsh 无 find/ls），经 outputSchema 返回结构化警告数组；emission guard 仍由 runtime
 * 在评审完成后逐条执行（上游的「工具调用时逐条 guard + 反馈」是评审者内部机制，
 * 可观察语义不变：警告经 guard 过滤后才进入投递）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { WatchdogReviewFunction, WatchdogReviewRequest } from './runtime.ts'
import type { ResolvedWatchdogConfig } from './types.ts'
import type { WatchdogWarning } from './types.ts'
import { WATCHDOG_WARNING_CATEGORIES, WATCHDOG_WARNING_CONFIDENCES, WATCHDOG_WARNING_SEVERITIES } from './types.ts'
import { assertSupportedThinking, resolveWatchdogModelInput, type ThinkingLevel, type WatchdogModelContext } from './model-selection.ts'

/** dsh 可用只读工具（上游 read/grep/find/ls；dsh 无 find/ls，用 glob）。 */
export const WATCHDOG_ALLOWED_TOOL_NAMES = ['read', 'grep', 'glob']

/** 评审结构化输出的 JSON Schema（dsh outputSchema 子集）。 */
const WATCHDOG_WARNINGS_SCHEMA = {
  type: 'object',
  properties: {
    warnings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: [...WATCHDOG_WARNING_SEVERITIES] },
          summary: { type: 'string' },
          evidence: { type: 'string' },
          recommendedAction: { type: 'string' },
          category: { type: 'string', enum: [...WATCHDOG_WARNING_CATEGORIES] },
          confidence: { type: 'string', enum: [...WATCHDOG_WARNING_CONFIDENCES] },
        },
        required: ['severity', 'summary', 'evidence', 'recommendedAction'],
        additionalProperties: false,
      },
    },
  },
  required: ['warnings'],
  additionalProperties: false,
} as const

export interface WatchdogReviewModelSelection {
  model: string
  thinking: ThinkingLevel | false | undefined
  explicit: boolean
}

export interface WatchdogReviewDeps {
  ctx: Context
  modelContext: WatchdogModelContext
  /** 被评审会话的 agent（评审时点取）。 */
  getAgent: () => Agent | undefined
  /** 评审者子代理会话 id 回传（供主监听排除，避免评审回合再次触发 watchdog）。 */
  onReviewerSession?: (sessionId: string) => void
}

function nonEmptyString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`review warning '${field}' must be a non-empty string.`)
  return value.trim()
}

function toWatchdogWarning(params: Record<string, unknown>): WatchdogWarning {
  const severity = params.severity
  if (typeof severity !== 'string' || !(WATCHDOG_WARNING_SEVERITIES as readonly string[]).includes(severity)) {
    throw new Error(`review warning severity must be one of ${WATCHDOG_WARNING_SEVERITIES.join(', ')}.`)
  }
  const category = params.category
  if (category !== undefined && (typeof category !== 'string' || !(WATCHDOG_WARNING_CATEGORIES as readonly string[]).includes(category))) {
    throw new Error(`review warning category must be one of ${WATCHDOG_WARNING_CATEGORIES.join(', ')}.`)
  }
  const confidence = params.confidence
  if (confidence !== undefined && (typeof confidence !== 'string' || !(WATCHDOG_WARNING_CONFIDENCES as readonly string[]).includes(confidence))) {
    throw new Error(`review warning confidence must be one of ${WATCHDOG_WARNING_CONFIDENCES.join(', ')}.`)
  }
  return {
    severity: severity as WatchdogWarning['severity'],
    category: (category as WatchdogWarning['category']) ?? 'other',
    confidence: (confidence as WatchdogWarning['confidence']) ?? 'medium',
    source: 'main',
    summary: nonEmptyString(params.summary, 'summary'),
    evidence: nonEmptyString(params.evidence, 'evidence'),
    recommendedAction: nonEmptyString(params.recommendedAction, 'recommendedAction'),
  }
}

function buildWatchdogSystemPrompt(cwd: string, options: { hasScope?: boolean } = {}): string {
  return [
    'You are the main-session subagent watchdog.',
    `Working directory: ${cwd}`,
    'Review only the supplied parent turn delta. Inspect repository files only when needed to verify a concrete concern.',
    options.hasScope ? "When the review input includes a Current scope block, treat newer scope prompts as superseding/mutating older prompts and use category='scope-drift' for work that serves no current scope item." : undefined,
    'You are read-only. You may use read, grep, and glob. Do not edit files, run shell commands, spawn agents, or mutate state.',
    'Report warnings ONLY in the required structured JSON output. Freeform assistant text is ignored and must not be used to report warnings.',
    'Emit only medium/high confidence actionable concerns or blockers: missed user constraints, correctness risks, test gaps that matter, unsafe changes, stale facts, loop risks, or scope drift.',
    'Do not emit nits, style preferences, low-confidence guesses, informational notes, praise, or summaries.',
    "If the turn is clean, respond with {\"warnings\": []}.",
    "Use severity='blocker' only when the issue should stop acceptance until addressed; otherwise use severity='concern'.",
  ].filter((line): line is string => Boolean(line)).join('\n')
}

function buildReviewPrompt(request: WatchdogReviewRequest, selection: WatchdogReviewModelSelection): string {
  return [
    'Review this parent-session turn delta for subagent-watchdog-worthy issues.',
    `Review id: ${request.reviewId}; epoch: ${request.epoch}; review model: ${selection.model}; thinking: ${selection.thinking ?? 'inherit'}.`,
    'Respond with ONLY the structured warnings JSON ({"warnings": [...]}); empty array when clean.',
    '<turn_delta>',
    request.delta,
    '</turn_delta>',
  ].join('\n\n')
}

/** 解析评审模型：配置的 main.model → 严格解析；未配置 → 继承父会话路由。 */
export async function resolveWatchdogReviewModel(
  modelContext: WatchdogModelContext,
  config: ResolvedWatchdogConfig,
): Promise<WatchdogReviewModelSelection> {
  const main = config.main
  if (main.model) {
    const resolved = await resolveWatchdogModelInput(modelContext, main.model)
    const thinking = resolved.thinking
      ?? (main.thinking === undefined ? undefined : main.thinking === false ? false : assertSupportedThinking(main.thinking, 'watchdog config'))
    return { model: resolved.model, thinking, explicit: true }
  }
  const parent = modelContext.parentRoute
  if (!parent?.provider || !parent.model) {
    throw new Error('Main watchdog review cannot run because the current session model is unavailable and watchdog.main.model is not configured.')
  }
  return {
    model: `${parent.provider}/${parent.model}`,
    thinking: main.thinking === undefined ? undefined : main.thinking === false ? false : assertSupportedThinking(main.thinking, 'watchdog config'),
    explicit: false,
  }
}

function mapStopReason(reason: string | undefined): 'stop' | 'error' | 'aborted' | 'length' {
  if (reason === 'aborted') return 'aborted'
  if (reason === 'error' || reason === 'refusal') return 'error'
  if (reason === 'max-tokens') return 'length'
  return 'stop'
}

/** 创建评审函数：以只读子代理运行评审，结构化输出警告。 */
export function createWatchdogReview(deps: WatchdogReviewDeps): WatchdogReviewFunction {
  return async (request) => {
    const { ctx, modelContext, getAgent } = deps
    const selection = await resolveWatchdogReviewModel(modelContext, request.config)
    const parent = getAgent()
    if (!parent) throw new Error('Watchdog review cannot run without the reviewed agent.')

    const named = selection.model.indexOf('/')
    const provider = named > 0 ? selection.model.slice(0, named) : selection.model
    const model = named > 0 ? selection.model.slice(named + 1) : selection.model

    const handle = await ctx.subagents.start('spawn', {
      label: `watchdog review · ${request.reviewId}`,
      prompt: [{ type: 'text', text: buildReviewPrompt(request, selection) }],
      parent,
      signal: request.signal ?? new AbortController().signal,
      ...(provider ? { agentOptions: { provider, model } } : {}),
      persona: buildWatchdogSystemPrompt(parent.session.header.cwd ?? process.cwd(), { hasScope: request.hasScope }),
      toolFilter: { allow: [...WATCHDOG_ALLOWED_TOOL_NAMES] },
      maxDepth: 0,
      outputSchema: WATCHDOG_WARNINGS_SCHEMA as never,
    })
    deps.onReviewerSession?.(handle.id)
    const result = await handle.result
    if (result.stopReason !== 'completed') {
      return { stopReason: mapStopReason(result.stopReason) }
    }
    const structured = result.structured as { warnings?: unknown[] } | undefined
    const warnings: WatchdogWarning[] = []
    for (const entry of structured?.warnings ?? []) {
      if (entry && typeof entry === 'object') {
        try {
          warnings.push(toWatchdogWarning(entry as Record<string, unknown>))
        } catch (error) {
          // 单条非法警告跳过，不使整个评审失败（与上游 watchdog_warn 校验等价）
          ctx.logger.warn(`[watchdog] invalid review warning skipped: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    for (const warning of warnings) request.emitWarning(warning)
    return { stopReason: 'stop' }
  }
}
