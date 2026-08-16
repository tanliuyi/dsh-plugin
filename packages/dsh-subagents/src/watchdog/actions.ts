/**
 * Watchdog 管理动作（对齐上游 pi-subagents src/watchdog/tool-actions.ts）：
 * watchdog.status / recommend-model / check / configure。
 * configure 支持 target（main/children/child+agent）与 scope（session/user/project）：
 * - scope 'session' → 会话级覆盖（不落盘，runtime.setSessionModel）；
 * - scope 'user'/'project' → 写入对应 settings 文件（writeWatchdogModelSettings）。
 */

import type { SubagentsParams } from '../types.ts'
import type { SubagentsDeps, ExecContext } from '../runs/execution.ts'
import { writeWatchdogModelSettings, type WatchdogModelSettingsTarget } from './settings.ts'
import { buildCheckText, buildRecommendationText, buildWatchdogStatus } from './main.ts'
import {
  parseWatchdogThinkingInput,
  recommendStrongWatchdogModel,
  resolveWatchdogModelInput,
  type ThinkingLevel,
  type WatchdogLlmFace,
  type WatchdogModelContext,
} from './model-selection.ts'

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseScope(raw: string | undefined): 'session' | 'user' | 'project' {
  if (raw === undefined || raw === 'session') return 'session'
  if (raw === 'user' || raw === 'project') return raw
  throw new Error("watchdog.configure scope must be 'session', 'user', or 'project'.")
}

function parseTarget(params: SubagentsParams): WatchdogModelSettingsTarget {
  const target = params.target ?? 'main'
  if (target === 'main') return { kind: 'main' }
  if (target === 'children') return { kind: 'children' }
  if (target === 'child') {
    if (!params.agent?.trim()) throw new Error("watchdog.configure target='child' requires agent.")
    return { kind: 'child', agent: params.agent.trim() }
  }
  throw new Error("watchdog.configure target must be 'main', 'children', or 'child'.")
}

function parseThinking(raw: string | false | undefined): ThinkingLevel | false | null | undefined {
  if (raw === undefined) return undefined
  if (raw === 'inherit') return null
  return parseWatchdogThinkingInput(raw, 'watchdog.configure thinking') ?? undefined
}

async function resolveConfiguredValue(
  modelContext: WatchdogModelContext,
  params: SubagentsParams,
): Promise<{ model?: string | null; thinking?: ThinkingLevel | false | null; description: string }> {
  const thinking = parseThinking(params.thinking)
  const rawModel = typeof params.model === 'string' ? params.model.trim() : undefined
  if (!rawModel) {
    if (thinking === undefined) throw new Error('watchdog.configure requires model, thinking, or both.')
    return { thinking, description: `thinking ${thinking === null ? 'inherit' : thinking === false ? 'off' : thinking}` }
  }
  if (rawModel === 'inherit') return { model: null, thinking: thinking ?? null, description: 'inherit' }
  if (rawModel === 'recommended') {
    const recommendation = await recommendStrongWatchdogModel(modelContext)
    return {
      model: recommendation.model,
      thinking: recommendation.thinking,
      description: `${recommendation.model}:${recommendation.thinking}`,
    }
  }
  const resolved = await resolveWatchdogModelInput(modelContext, rawModel)
  return {
    model: resolved.model,
    thinking: resolved.thinking ?? thinking,
    description: `${resolved.model}${resolved.thinking ?? thinking ? `:${resolved.thinking ?? thinking}` : ''}`,
  }
}

export async function runWatchdogAction(
  deps: SubagentsDeps,
  exec: ExecContext,
  params: SubagentsParams,
  action: string,
  _projectRoot: string,
): Promise<{ text: string; details: import('../types.ts').Details }> {
  const { ctx } = deps
  const llm = ctx.get('llm') as unknown as WatchdogLlmFace
  const modelContext: WatchdogModelContext = {
    llm,
    parentRoute: { provider: exec.parent.options?.provider, model: exec.parent.options?.model },
  }
  const cwd = exec.parent.session.header.cwd ?? process.cwd()
  const runtime = deps.watchdog?.runtimeFor(exec.parent.session.id, cwd)
  const result = (text: string, isError = false): { text: string; details: import('../types.ts').Details } => ({
    text,
    details: { kind: isError ? 'error' : 'watchdog', results: [] },
  })
  try {
    if (action === 'watchdog.status') {
      if (!runtime) return result('Subagent watchdog runtime is unavailable.', true)
      return result(await buildWatchdogStatus(runtime.getSnapshot(cwd), exec.parent, llm))
    }
    if (action === 'watchdog.recommend-model') {
      return result(await buildRecommendationText(llm, exec.parent))
    }
    if (action === 'watchdog.check') {
      if (!runtime) return result('Subagent watchdog runtime is unavailable.', true)
      return result(await buildCheckText(runtime, exec.parent, llm))
    }
    if (action !== 'watchdog.configure') return result(`Unknown watchdog action: ${action}`, true)

    const scope = parseScope(params.scope)
    const target = parseTarget(params)
    const value = await resolveConfiguredValue(modelContext, params)
    if (scope === 'session') {
      if (!runtime) return result('Subagent watchdog runtime is unavailable.', true)
      if (target.kind !== 'main') return result("Session-scoped watchdog.configure currently supports target='main' only.", true)
      runtime.setSessionModel({ model: value.model ?? null, thinking: value.thinking ?? null }, cwd)
      return result([
        `Subagent watchdog session model configured: ${value.description}.`,
        'No settings files were changed.',
        '',
        await buildWatchdogStatus(runtime.getSnapshot(cwd), exec.parent, llm),
      ].join('\n'))
    }

    const settingsPath = writeWatchdogModelSettings({
      scope,
      cwd,
      target,
      model: value.model,
      thinking: value.thinking,
    }, deps.home)
    runtime?.refreshConfig(cwd)
    return result([
      `Subagent watchdog model saved: ${value.description}.`,
      `Updated: ${settingsPath}`,
      `Scope: ${scope}`,
      value.model === null ? 'The watchdog now inherits the current session model and thinking.' : 'Run /subagents-watchdog on if the watchdog is still off.',
    ].join('\n'))
  } catch (error) {
    return result(`Subagent watchdog\n\n${messageFromError(error)}`, true)
  }
}
