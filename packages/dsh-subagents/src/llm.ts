/**
 * 辅助 LLM 调用：解析 provider/model 路由并流式取回纯文本。
 * 用于 agent 选择、watchdog 评审、refine 提案等插件侧推理。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createMessage, type ReasoningEffortId } from '@deepseek-ai/dsh-llm'

export interface LlmRoute {
  provider: string
  model: string
  reasoningEffort?: string
}

/** 从 pi 风格 model id（`provider/model[:effort]` 或裸 id）解析 dsh 路由。 */
export function parseModelSpec(spec: string | undefined): { provider?: string; model?: string; effort?: string } {
  if (!spec) return {}
  let rest = spec.trim()
  let effort: string | undefined
  const colon = rest.lastIndexOf(':')
  if (colon > 0) {
    const suffix = rest.slice(colon + 1)
    if (suffix === 'off' || suffix === 'minimal' || suffix === 'low' || suffix === 'medium' || suffix === 'high' || suffix === 'xhigh' || suffix === 'max') {
      effort = suffix
      rest = rest.slice(0, colon)
    }
  }
  const out: { provider?: string; model?: string; effort?: string } = {}
  if (effort) out.effort = effort
  const slash = rest.indexOf('/')
  if (slash > 0) {
    const provider = rest.slice(0, slash)
    const model = rest.slice(slash + 1)
    if (provider && model) {
      out.provider = provider
      out.model = model
      return out
    }
    if (model) {
      out.model = model
      return out
    }
  }
  if (rest) out.model = rest
  return out
}

/** 模糊匹配模型 id（provider 分隔符、大小写、`-`/`.` 归一化）。 */
export function fuzzyMatchModel(actual: string, wanted: string): boolean {
  const normalize = (id: string): string => id.toLowerCase().replace(/[._:]/g, '-').replace(/-+/g, '-')
  const a = normalize(actual)
  const w = normalize(wanted)
  if (a === w) return true
  // 允许裸 id 匹配带 provider 前缀的完整 id 的尾部
  return a.endsWith(w) || w.endsWith(a)
}

/**
 * 解析一条调用路由：显式 spec > 调用方 agent options > 注册表第一个 provider/model。
 * 返回 undefined 表示没有任何可用路由。
 */
export async function resolveLlmRoute(
  ctx: Context,
  spec?: string,
  agentRoute?: { provider?: string; model?: string },
): Promise<LlmRoute | undefined> {
  const llm = ctx.get('llm')
  if (!llm) return undefined
  const parsed = parseModelSpec(spec)
  const providers = llm.listProviders()
  if (providers.length === 0) return undefined

  const tryExact = async (provider: string, model: string): Promise<LlmRoute | undefined> => {
    if (providers.some((p) => p.name === provider)) {
      return { provider, model, reasoningEffort: parsed.effort }
    }
    return undefined
  }

  // 1) 显式 spec
  if (parsed.provider && parsed.model) {
    const route = await tryExact(parsed.provider, parsed.model)
    if (route) return route
  }
  if (parsed.model) {
    // 2) 裸 model：先试调用方 provider，再模糊匹配所有 provider
    const candidates: Array<{ provider: string; model: string }> = []
    if (agentRoute?.provider && agentRoute.model) candidates.push({ provider: agentRoute.provider, model: agentRoute.model })
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider.name)
        for (const info of models) {
          if (fuzzyMatchModel(info.id, parsed.model)) candidates.push({ provider: provider.name, model: info.id })
        }
      } catch {
        // 跳过不可查询的 provider
      }
    }
    // 优先调用方 provider 的命中
    const preferred = agentRoute?.provider ? candidates.find((c) => c.provider === agentRoute.provider) : undefined
    const pick = preferred ?? candidates[0]
    if (pick) return { provider: pick.provider, model: pick.model, reasoningEffort: parsed.effort }
    // 3) 注册表第一个 provider 的第一个 model
    for (const provider of providers) {
      try {
        const models = await llm.listModels(provider.name)
        if (models.length > 0) return { provider: provider.name, model: models[0]!.id, reasoningEffort: parsed.effort }
      } catch {
        // 继续
      }
    }
  }
  // 4) 调用方 agent 路由
  if (agentRoute?.provider && agentRoute.model) {
    return { provider: agentRoute.provider, model: agentRoute.model, reasoningEffort: parsed.effort }
  }
  // 5) 注册表第一个 provider（model 空则留给 adapter 默认解析）
  return { provider: providers[0]!.name, model: parsed.model ?? '', reasoningEffort: parsed.effort }
}

export interface StreamTextOptions {
  provider: string
  model: string
  system?: string
  user: string
  reasoningEffort?: string
  signal?: AbortSignal
  maxTokens?: number
}

/** 流式调用并拼接文本；失败/中止返回 undefined。 */
export async function streamText(ctx: Context, options: StreamTextOptions): Promise<string | undefined> {
  const llm = ctx.get('llm')
  if (!llm) return undefined
  const source = { kind: 'plugin' as const, plugin: 'dsh-subagents' }
  const messages = []
  if (options.system) {
    messages.push(createMessage({ role: 'system', content: [{ type: 'text', text: options.system }], source }))
  }
  messages.push(createMessage({ role: 'user', content: [{ type: 'text', text: options.user }], source }))
  let text = ''
  try {
    for await (const chunk of llm.stream({
      provider: options.provider,
      model: options.model,
      ...(options.reasoningEffort ? { reasoningEffort: options.reasoningEffort as ReasoningEffortId } : {}),
      messages,
      ...(options.maxTokens ? { maxTokens: options.maxTokens } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      else if (chunk.type === 'finish' && chunk.reason.kind !== 'stop' && chunk.reason.kind !== 'max-tokens') return undefined
    }
  } catch {
    return undefined
  }
  return text.trim() || undefined
}
