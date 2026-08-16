/**
 * Watchdog 模型选择（对齐上游 pi-subagents src/watchdog/model-selection.ts）：
 * - 严格解析 `provider/model[:thinking]` 到已注册的 provider + 已发现模型（认证面 =
 *   llm 服务中已注册的 adapter 目录）；
 * - 未配置 main.model 时继承父会话模型路由；
 * - 推荐互补强模型（Opus 4.8 / GPT 5.5）。
 */

import { fuzzyMatchModel, parseModelSpec } from '../llm.ts'

export const THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const
export type ThinkingLevel = typeof THINKING_LEVELS[number]

/** dsh llm 服务的结构化面（只依赖本模块需要的成员）。 */
export interface WatchdogLlmFace {
  listProviders(): Array<{ name: string }>
  listModels(provider: string): Promise<Array<{ id: string }>>
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<unknown>
}

export const STRONG_WATCHDOG_THINKING: ThinkingLevel = 'high'

const STRONG_WATCHDOG_MODELS = {
  opus48: {
    label: 'Opus 4.8',
    queries: [
      'anthropic/claude-opus-4-8',
      'anthropic/claude-opus-4.8',
      'anthropic/opus-4-8',
      'anthropic/opus-4.8',
    ],
  },
  gpt55: {
    label: 'GPT 5.5',
    queries: [
      'openai-codex/gpt-5.5',
      'openai-codex/gpt-5-5',
      'openai/gpt-5.5',
      'openai/gpt-5-5',
    ],
  },
} as const

type StrongWatchdogFamily = keyof typeof STRONG_WATCHDOG_MODELS

export interface ResolvedWatchdogModelInput {
  model: string
  thinking?: ThinkingLevel
}

export interface WatchdogModelRecommendation {
  model: string
  thinking: ThinkingLevel
  label: string
  reason: string
}

/** 模型解析依赖面：llm 服务 + 父会话路由（未配置时的继承来源）。 */
export interface WatchdogModelContext {
  llm: WatchdogLlmFace
  parentRoute?: { provider?: string; model?: string }
}

export function fullModelId(model: { provider: string; id: string }): string {
  return `${model.provider}/${model.id}`
}

function normalizeModelSegment(value: string): string {
  return value.toLowerCase().replace(/[._:]/g, '-').replace(/-+/g, '-')
}

function splitProviderModel(value: string): { provider: string; id: string } | undefined {
  const slashIndex = value.indexOf('/')
  if (slashIndex <= 0 || slashIndex === value.length - 1) return undefined
  return { provider: value.slice(0, slashIndex), id: value.slice(slashIndex + 1) }
}

export function assertSupportedThinking(value: string, source: string): ThinkingLevel {
  if ((THINKING_LEVELS as readonly string[]).includes(value)) return value as ThinkingLevel
  throw new Error(`Unsupported watchdog thinking '${value}' from ${source}; expected ${THINKING_LEVELS.join(', ')}, false, or inherit.`)
}

export function parseWatchdogThinkingInput(value: string | false | undefined, source = 'watchdog input'): ThinkingLevel | false | undefined {
  if (value === undefined || value === '') return undefined
  if (value === false) return false
  if (value === 'false') return false
  return assertSupportedThinking(value, source)
}

async function availableModels(ctx: WatchdogModelContext): Promise<Array<{ provider: string; id: string }>> {
  const out: Array<{ provider: string; id: string }> = []
  for (const provider of ctx.llm.listProviders()) {
    try {
      const models = await ctx.llm.listModels(provider.name)
      for (const info of models) out.push({ provider: provider.name, id: info.id })
    } catch {
      // 跳过不可查询的 provider
    }
  }
  return out
}

async function hasModel(ctx: WatchdogModelContext, provider: string, id: string): Promise<boolean> {
  const providerNames = ctx.llm.listProviders().map((p) => p.name)
  if (!providerNames.includes(provider)) return false
  try {
    const models = await ctx.llm.listModels(provider)
    return models.some((info) => info.id === id)
  } catch {
    return false
  }
}

export async function resolveWatchdogModelInput(ctx: WatchdogModelContext, rawModel: string): Promise<ResolvedWatchdogModelInput> {
  const trimmed = rawModel.trim()
  if (!trimmed) throw new Error('Watchdog model must be a non-empty provider/model value.')
  const parsed = parseModelSpec(trimmed)
  const available = await availableModels(ctx)
  const preferredProvider = ctx.parentRoute?.provider

  // 候选解析：显式 provider/model → 精确命中；裸 model → 先试父 provider，再模糊匹配
  let provider: string | undefined
  let model: string | undefined
  let thinkingSuffix: string | undefined
  if (parsed.provider && parsed.model) {
    provider = parsed.provider
    model = parsed.model
  } else if (parsed.model) {
    if (preferredProvider) {
      const hit = available.find((entry) => entry.provider === preferredProvider && fuzzyMatchModel(entry.id, parsed.model!))
      if (hit) {
        provider = hit.provider
        model = hit.id
      }
    }
    if (!provider) {
      const hit = available.find((entry) => fuzzyMatchModel(entry.id, parsed.model!))
      if (hit) {
        provider = hit.provider
        model = hit.id
      }
    }
  }
  if (!provider || !model) {
    throw new Error(`Watchdog model '${rawModel}' did not resolve to a registered provider/model. Use a provider-qualified model such as openai-codex/gpt-5.5:high or anthropic/claude-opus-4-8:high.`)
  }
  // 严格命中校验：provider 必须已注册、model 必须在该 provider 的目录中
  if (!(await hasModel(ctx, provider, model))) {
    throw new Error(`Watchdog model '${rawModel}' was not found as '${provider}/${model}'. Configure the provider or choose a discovered model.`)
  }
  thinkingSuffix = parsed.effort
  return {
    model: `${provider}/${model}`,
    ...(thinkingSuffix ? { thinking: assertSupportedThinking(thinkingSuffix, 'watchdog model suffix') } : {}),
  }
}

function familyForModel(model: { provider: string; id: string } | undefined): StrongWatchdogFamily | undefined {
  if (!model) return undefined
  const provider = normalizeModelSegment(model.provider)
  const id = normalizeModelSegment(model.id)
  if (provider.includes('openai') && /^gpt-5-5(-\d{8}|-\d{4}-\d{2}-\d{2})?$/.test(id)) return 'gpt55'
  if (provider.includes('anthropic') && /^(claude-opus-4-8|opus-4-8)(-\d{8}|-\d{4}-\d{2}-\d{2})?$/.test(id)) return 'opus48'
  return undefined
}

function currentProviderFamily(ctx: WatchdogModelContext): 'openai' | 'anthropic' | undefined {
  const provider = ctx.parentRoute?.provider ? normalizeModelSegment(ctx.parentRoute.provider) : ''
  if (provider.includes('openai')) return 'openai'
  if (provider.includes('anthropic')) return 'anthropic'
  return undefined
}

function strongFamilyOrder(ctx: WatchdogModelContext): StrongWatchdogFamily[] {
  const current = ctx.parentRoute ? familyForModel({ provider: ctx.parentRoute.provider ?? '', id: ctx.parentRoute.model ?? '' }) : undefined
  if (current === 'gpt55') return ['opus48']
  if (current === 'opus48') return ['gpt55']
  const providerFamily = currentProviderFamily(ctx)
  if (providerFamily === 'openai') return ['opus48', 'gpt55']
  if (providerFamily === 'anthropic') return ['gpt55', 'opus48']
  return ['gpt55', 'opus48']
}

async function findFamilyMatch(family: StrongWatchdogFamily, available: Array<{ provider: string; id: string }>): Promise<string | undefined> {
  const matches = available.filter((entry) => familyForModel(entry) === family)
  if (matches.length === 1) return fullModelId(matches[0]!)
  return undefined
}

async function supportsHighThinking(ctx: WatchdogModelContext, provider: string, model: string): Promise<boolean> {
  try {
    const info = await ctx.llm.resolveModelInfo(provider, model, undefined)
    const reasoning = (info as { reasoning?: { efforts?: Array<{ id: string }> } } | undefined)?.reasoning
    if (reasoning?.efforts && reasoning.efforts.length > 0) {
      return reasoning.efforts.some((effort) => effort.id === 'high' || effort.id === 'xhigh' || effort.id === 'max')
    }
    return true // adapter 未暴露级别时不做限制
  } catch {
    return true
  }
}

async function resolveStrongCandidate(ctx: WatchdogModelContext, family: StrongWatchdogFamily): Promise<WatchdogModelRecommendation | undefined> {
  const available = await availableModels(ctx)
  const preference = STRONG_WATCHDOG_MODELS[family]
  const queries: string[] = [...preference.queries]
  const familyMatch = await findFamilyMatch(family, available)
  if (familyMatch) queries.push(familyMatch)
  for (const query of queries) {
    let resolved: ResolvedWatchdogModelInput
    try {
      resolved = await resolveWatchdogModelInput(ctx, query)
    } catch {
      continue
    }
    const named = splitProviderModel(resolved.model)
    if (!named) continue
    if (familyForModel(named) !== family) continue
    if (!(await supportsHighThinking(ctx, named.provider, named.id))) continue
    const current = ctx.parentRoute?.provider && ctx.parentRoute.model
      ? fullModelId({ provider: ctx.parentRoute.provider, id: ctx.parentRoute.model })
      : 'no current session model'
    return {
      model: resolved.model,
      thinking: STRONG_WATCHDOG_THINKING,
      label: preference.label,
      reason: `Use ${preference.label} with thinking high as a strong independent watchdog for ${current}.`,
    }
  }
  return undefined
}

export async function recommendStrongWatchdogModel(ctx: WatchdogModelContext): Promise<WatchdogModelRecommendation> {
  for (const family of strongFamilyOrder(ctx)) {
    const recommendation = await resolveStrongCandidate(ctx, family)
    if (recommendation) return recommendation
  }
  const current = ctx.parentRoute?.provider && ctx.parentRoute.model
    ? fullModelId({ provider: ctx.parentRoute.provider, id: ctx.parentRoute.model })
    : 'the current session'
  throw new Error(`No authenticated strong complementary watchdog model was found for ${current}. Configure access to Opus 4.8 or GPT 5.5, then run the recommendation again.`)
}
