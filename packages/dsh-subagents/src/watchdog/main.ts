/**
 * Watchdog 注册（对齐上游 pi-subagents src/watchdog/register-main.ts 的接线面）：
 * - 每个会话一个 MainWatchdogRuntime（主会话用 main 端点；子代理会话用 children
 *   端点配置，独立状态与 auto-follow）；
 * - dsh 事件映射：turn/start → 回合开始（重置/基线），user/message → scope 与
 *   auto-follow 识别（source.kind === 'user' = 真实 prompt；plugin 来源 = 本
 *   watchdog 的 auto-follow 候选），assistant/message、tool/call、tool/result →
 *   回合 delta，turn/end → 评审边界（agent_end 等价），cadence 在 tool/result；
 * - 投递：边界警告在 agent 空闲时 followup（上游 held 显示语义），cadence 警告
 *   以 steer 注入运行中的 agent（上游 deliverAs: 'steer'），auto-follow 以
 *   插件来源的 followup 消息唤醒（上游 sendUserMessage）；
 * - 命令面：/subagents-watchdog status|on|off|session on|off|session model|
 *   model|thinking|recommend-model|check|test（对齐上游 register-main 命令面）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SubagentsConfig } from '../types.ts'
import { deliverNotice } from '../intercom/deliver.ts'
import { MainWatchdogRuntime, type WatchdogRuntimeSnapshot } from './runtime.ts'
import { createWatchdogReview } from './review.ts'
import {
  resolveWatchdogConfig,
  writeUserWatchdogEnabled,
  writeWatchdogModelSettings,
  getWatchdogUserSettingsPath,
  getWatchdogProjectSettingsPath,
  type WatchdogModelSettingsTarget,
  type WatchdogSettingsWriteScope,
} from './settings.ts'
import { formatWatchdogWarningContent } from './warning-format.ts'
import {
  parseWatchdogThinkingInput,
  recommendStrongWatchdogModel,
  resolveWatchdogModelInput,
  THINKING_LEVELS,
  type ThinkingLevel,
  type WatchdogLlmFace,
} from './model-selection.ts'
import type { WatchdogWarningDetails } from './types.ts'

/** registerWatchdog 的依赖。 */
export interface WatchdogDeps {
  ctx: Context
  config: SubagentsConfig
  home: string
  /** 子代理会话 → agent 名（children.overrides 查找用）。 */
  childAgentName?: (sessionId: string) => string | undefined
}

/** watchdog 控制面（slash 命令与工具 action 共用）。 */
export interface WatchdogController {
  runtimeFor(sessionId: string, cwd?: string): MainWatchdogRuntime | undefined
  handleCommand(invocation: { agent: Agent; rawInput: string; signal: AbortSignal }): Promise<{ kind: 'success' | 'error'; text: string }>
  dispose(): void
}

function messageFromError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boolLabel(value: boolean): string {
  return value ? 'on' : 'off'
}

function statusLabel(status: string): string {
  return status.replaceAll('-', ' ')
}

function splitKnownThinkingSuffix(value: string): { baseModel: string; suffix?: string } {
  const colon = value.lastIndexOf(':')
  if (colon > 0) {
    const suffix = value.slice(colon + 1)
    if ((THINKING_LEVELS as readonly string[]).includes(suffix)) return { baseModel: value.slice(0, colon), suffix }
  }
  return { baseModel: value }
}

function sourceLine(source: { scope: string; path?: string; exists: boolean }): string {
  const location = source.path ? ` ${source.path}` : ''
  return `- ${source.scope}${location}: ${source.exists ? 'found' : 'not found'}`
}

function currentSessionModelLine(agent: Agent): string {
  const provider = agent.options?.provider
  const model = agent.options?.model
  if (provider && model) return `current session (${provider}/${model})`
  return 'current session (not configured)'
}

function mainModelLine(snapshot: ReturnType<MainWatchdogRuntime['getSnapshot']>, agent: Agent): string {
  if (snapshot.config.main.model) {
    const source = snapshot.sessionModelOverride?.model ? 'session override' : 'configured'
    return `Main model: ${splitKnownThinkingSuffix(snapshot.config.main.model).baseModel} (${source})`
  }
  return `Main model: ${currentSessionModelLine(agent)}`
}

function childrenLine(snapshot: ReturnType<MainWatchdogRuntime['getSnapshot']>): string {
  const children = snapshot.config.children
  const model = children.model ? splitKnownThinkingSuffix(children.model).baseModel : 'current child session'
  const thinking = children.thinking === undefined ? 'current child session' : children.thinking === false ? 'off' : children.thinking
  const overrides = Object.entries(children.overrides)
  const overrideText = overrides.length
    ? ` · overrides ${overrides.map(([agent, override]) => {
      const bits = [agent]
      if (override.enabled !== undefined) bits.push(boolLabel(override.enabled))
      if (override.model) bits.push(splitKnownThinkingSuffix(override.model).baseModel)
      if (override.thinking !== undefined) bits.push(`thinking ${override.thinking === false ? 'off' : override.thinking}`)
      return bits.join(' ')
    }).join('; ')}`
    : ''
  return `Children: ${boolLabel(snapshot.config.enabled && children.enabled)} · model ${model} · thinking ${thinking}${overrideText}`
}

function lspLine(snapshot: ReturnType<MainWatchdogRuntime['getSnapshot']>): string {
  const lsp = snapshot.lsp
  const provider = lsp.provider ? ` · ${lsp.provider}` : ''
  const counts = lsp.diagnosticCount > 0 || lsp.freshDiagnosticCount > 0
    ? ` · ${lsp.freshDiagnosticCount} new/${lsp.diagnosticCount} total`
    : ''
  const message = lsp.message ? ` · ${lsp.message}` : ''
  return `LSP diagnostics: ${lsp.enabled ? 'on' : 'off'} · ${lsp.status}${provider}${counts}${message}`
}

function mainThinkingLine(snapshot: ReturnType<MainWatchdogRuntime['getSnapshot']>, agent: Agent): string {
  const configuredModel = snapshot.config.main.model
  const configuredThinking = snapshot.config.main.thinking
  if (configuredModel) {
    const suffix = splitKnownThinkingSuffix(configuredModel).suffix
    if (suffix) return suffix
    if (configuredThinking === false) return 'off'
    if (configuredThinking !== undefined) return configuredThinking
    return 'off (default for explicit watchdog model)'
  }
  if (configuredThinking === false) return 'off'
  if (configuredThinking !== undefined) return configuredThinking
  return 'current session'
}

export async function buildWatchdogStatus(snapshot: ReturnType<MainWatchdogRuntime['getSnapshot']>, agent: Agent, llm: WatchdogLlmFace): Promise<string> {
  const lines = [
    'Subagent watchdog',
    `Main: ${boolLabel(snapshot.enabled)}${!snapshot.config.enabled && snapshot.sessionOverride === undefined ? ' (default off)' : ''}`,
    `Runtime: ${statusLabel(snapshot.status)}${snapshot.bufferedDeltas > 0 ? ` · buffered deltas ${snapshot.bufferedDeltas}` : ''}`,
    `Review trigger: ${snapshot.reviewTrigger === 'repo-edits' ? 'repo edits only' : 'every non-empty turn delta'}`,
    `Scope context: ${snapshot.config.scope.enabled ? 'on' : 'off'}`,
    `Cadence: ${snapshot.config.cadence.everyNTools === null ? 'boundary only' : `every ${snapshot.config.cadence.everyNTools} tools + boundary`}`,
    lspLine(snapshot),
    `Session override: ${snapshot.sessionOverride === undefined ? 'none' : boolLabel(snapshot.sessionOverride)}`,
    mainModelLine(snapshot, agent),
    `Main thinking: ${mainThinkingLine(snapshot, agent)}`,
    childrenLine(snapshot),
    `Agent-end timeout: ${snapshot.config.agentEndTimeoutMs}ms`,
    `Auto-follow: ${snapshot.enabled && snapshot.config.autoFollow.blockers ? 'on for blockers' : 'off'} · attempts ${snapshot.autoFollowAttempts}${snapshot.config.autoFollow.maxAttempts === null ? '' : `/${snapshot.config.autoFollow.maxAttempts}`}${snapshot.autoFollowQueued ? ' · queued' : ''}${snapshot.autoFollowStalemate ? ' · stalemate' : ''}`,
    `Review model call: ${snapshot.reviewDescription}`,
  ]
  if (snapshot.failedReviews > 0) lines.push(`Failed reviews: ${snapshot.failedReviews}`)
  if (snapshot.staleReviews > 0) lines.push(`Stale reviews: ${snapshot.staleReviews}`)
  if (snapshot.changedPaths?.length) {
    lines.push(`Changed paths: ${snapshot.changedPaths.slice(0, 8).join(', ')}${snapshot.changedPaths.length > 8 ? `, +${snapshot.changedPaths.length - 8} more` : ''}`)
  }
  if (snapshot.lastWarning) {
    lines.push(`Last warning: ${snapshot.lastWarning.severity} · ${snapshot.lastWarning.state ?? 'candidate'} · ${snapshot.lastWarning.summary}`)
  }
  if (snapshot.lastError) lines.push(`Last error: ${snapshot.lastError}`)
  if (!snapshot.configOk) {
    lines.push('', 'Config errors:', ...snapshot.errors.map((error) => `- ${error.message}`), 'Watchdog is disabled until the config is fixed.')
  } else {
    lines.push('', 'Config: ok')
  }
  lines.push(
    'Sources:',
    ...snapshot.sources.map(sourceLine),
    '',
    'Model commands:',
    '- /subagents-watchdog recommend-model',
    '- /subagents-watchdog model recommended',
    '- /subagents-watchdog model <provider/model[:thinking]>',
    '- /subagents-watchdog model inherit',
    '- /subagents-watchdog session model recommended',
    'Agent action: subagent({ action: "watchdog.configure", model: "recommended", scope: "session" })',
  )
  try {
    const recommendation = await recommendStrongWatchdogModel({ llm, parentRoute: agent.options })
    lines.push('', `Recommended strong watchdog: ${recommendation.model}:${recommendation.thinking} (${recommendation.label}, complementary reviewer)`)
  } catch {
    // 推荐失败不阻塞状态面板
  }
  return lines.join('\n')
}

export async function buildRecommendationText(llm: WatchdogLlmFace, agent: Agent): Promise<string> {
  const recommendation = await recommendStrongWatchdogModel({ llm, parentRoute: agent.options })
  return [
    'Subagent watchdog recommended model',
    `Current session: ${currentSessionModelLine(agent)}`,
    `Recommended: ${recommendation.model}:${recommendation.thinking}`,
    `Reason: ${recommendation.reason}`,
    '',
    'Apply for this session:',
    '/subagents-watchdog session model recommended',
    '',
    'Save as your user default:',
    '/subagents-watchdog model recommended',
  ].join('\n')
}

export async function buildCheckText(runtime: MainWatchdogRuntime, agent: Agent, llm: WatchdogLlmFace): Promise<string> {
  const snapshot = runtime.getSnapshot(agent.session.header.cwd)
  if (!snapshot.configOk) {
    return ['Subagent watchdog config check', '', 'Config errors:', ...snapshot.errors.map((error) => `- ${error.message}`)].join('\n')
  }
  const lines = ['Subagent watchdog config check', '', 'Config: ok']
  if (snapshot.config.main.model) {
    try {
      const resolved = await resolveWatchdogModelInput({ llm, parentRoute: agent.options }, snapshot.config.main.model)
      lines.push(`Main model: ${resolved.model} auth ok`)
    } catch (error) {
      lines.push(`Main model check failed: ${messageFromError(error)}`)
    }
  } else {
    lines.push(`Main model: ${currentSessionModelLine(agent)}`)
  }
  lines.push(`Main thinking: ${mainThinkingLine(snapshot, agent)}`)
  lines.push(lspLine(snapshot))
  try {
    const recommendation = await recommendStrongWatchdogModel({ llm, parentRoute: agent.options })
    lines.push(`Recommended strong watchdog: ${recommendation.model}:${recommendation.thinking}`)
  } catch (error) {
    lines.push(`Recommended strong watchdog: unavailable (${messageFromError(error)})`)
  }
  return lines.join('\n')
}

function parseTestCommand(input: string): { severity: 'concern' | 'blocker'; text: string } | undefined {
  const match = input.match(/^test\s+(concern|blocker)\s+([\s\S]+)$/)
  if (!match) return undefined
  return { severity: match[1] as 'concern' | 'blocker', text: match[2]!.trim() }
}

function formatThinking(value: ThinkingLevel | false | undefined): string {
  if (value === undefined) return 'inherit'
  return value === false ? 'off' : value
}

function parseThinkingCommand(raw: string): ThinkingLevel | false | null {
  const value = raw.trim()
  if (value === 'inherit') return null
  return parseWatchdogThinkingInput(value, '/subagents-watchdog thinking') ?? null
}

async function resolveModelCommandValue(
  llm: WatchdogLlmFace,
  agent: Agent,
  raw: string,
): Promise<{ model: string | null; thinking: ThinkingLevel | false | null; description: string }> {
  const value = raw.trim()
  if (!value) throw new Error("Expected a model, 'recommended', or 'inherit'.")
  if (value === 'inherit') return { model: null, thinking: null, description: 'current session model and thinking' }
  if (value === 'recommended') {
    const recommendation = await recommendStrongWatchdogModel({ llm, parentRoute: agent.options })
    return {
      model: recommendation.model,
      thinking: recommendation.thinking,
      description: `${recommendation.model}:${recommendation.thinking} (${recommendation.label})`,
    }
  }
  const resolved = await resolveWatchdogModelInput({ llm, parentRoute: agent.options }, value)
  return {
    model: resolved.model,
    thinking: resolved.thinking ?? null,
    description: `${resolved.model}${resolved.thinking ? `:${resolved.thinking}` : ''}`,
  }
}

function formatWatchdogWarningMessageText(warning: WatchdogWarningDetails): string {
  return formatWatchdogWarningContent(warning)
}

/** 注册 watchdog：每会话 runtime + 事件接线 + 命令面。 */
export function registerWatchdog(deps: WatchdogDeps): WatchdogController {
  const { ctx } = deps
  const runtimes = new Map<string, MainWatchdogRuntime>()
  const reviewerSessions = new Set<string>()
  const llm = ctx.get('llm') as unknown as WatchdogLlmFace

  const isChildSession = (sessionId: string): boolean => {
    const session = ctx.get('sessions')?.get(sessionId as SessionId)
    return session?.header.origin === 'subagent' || session?.header.parentSession !== undefined
  }

  const createRuntimeFor = (sessionId: string, cwd: string): MainWatchdogRuntime | undefined => {
    const agent = ctx.get('agents')?.get(sessionId as SessionId)
    const child = isChildSession(sessionId)

    const resolveConfigSeam = (cwd2: string, options?: { session?: Record<string, unknown> }): ReturnType<typeof resolveWatchdogConfig> => {
      const base = resolveWatchdogConfig(cwd2, { ...options, config: deps.config.watchdog, home: deps.home })
      if (!base.ok || !child) return base
      // 子代理会话：children 端点配置覆盖 main（对齐上游 register-child 的
      // childResolvedConfig：children.enabled 未开 → 视为禁用）
      const children = base.config.children
      if (!children.enabled) return { ...base, config: { ...base.config, enabled: false, main: { ...base.config.main, enabled: false } } }
      return {
        ...base,
        config: {
          ...base.config,
          enabled: true,
          main: {
            enabled: true,
            ...(children.model ? { model: children.model } : base.config.main.model ? { model: base.config.main.model } : {}),
            ...(children.thinking !== undefined ? { thinking: children.thinking } : base.config.main.thinking !== undefined ? { thinking: base.config.main.thinking } : {}),
          },
          autoFollow: children.autoFollow ?? base.config.autoFollow,
        },
      }
    }

    const review = createWatchdogReview({
      ctx,
      modelContext: { llm, parentRoute: { provider: agent?.options?.provider, model: agent?.options?.model } },
      getAgent: () => ctx.get('agents')?.get(sessionId as SessionId) ?? undefined,
      onReviewerSession: (reviewerSessionId) => {
        reviewerSessions.add(reviewerSessionId)
      },
    })

    const runtime = new MainWatchdogRuntime({
      cwd,
      resolveConfig: resolveConfigSeam,
      review,
      reviewDescription: child ? 'child model review' : 'real model review',
      reviewChangesOnly: true,
      displayWarning: (details, options) => {
        const target = ctx.get('agents')?.get(sessionId as SessionId)
        if (!target) return
        const text = formatWatchdogWarningMessageText(details)
        if (options?.deliverAs === 'steer') {
          // cadence 评审：注入运行中的 agent（上游 deliverAs: 'steer'）
          if (target.status === 'running') {
            target.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'plugin', plugin: 'dsh-subagents' } }))
          } else {
            deliverNotice(target, text, 'followup')
          }
          return
        }
        // 边界警告（上游 held：run 结束后显示）：空闲才投递，运行中 withheld
        if (target.status === 'running') {
          ctx.logger.warn(`[watchdog] warning withheld while agent is running:\n${text}`)
          return
        }
        deliverNotice(target, text, 'followup')
      },
      sendUserMessage: (message) => {
        const target = ctx.get('agents')?.get(sessionId as SessionId)
        if (!target) return
        if (target.status === 'running') {
          ctx.logger.warn(`[watchdog] auto-follow withheld while agent is running:\n${message}`)
          return
        }
        target.followup(createUserMessage({ content: [{ type: 'text', text: message }], source: { kind: 'plugin', plugin: 'dsh-subagents' } }))
      },
    })
    return runtime
  }

  const runtimeFor = (sessionId: string, cwd?: string): MainWatchdogRuntime | undefined => {
    const existing = runtimes.get(sessionId)
    if (existing) return existing
    const cwdValue = cwd ?? ctx.get('sessions')?.get(sessionId as SessionId)?.header.cwd ?? process.cwd()
    const created = createRuntimeFor(sessionId, cwdValue)
    if (created) runtimes.set(sessionId, created)
    return created
  }

  // 清理：会话已消失的 runtime 与评审者标记
  const prune = (): void => {
    const sessions = ctx.get('sessions')
    if (!sessions) return
    for (const sessionId of runtimes.keys()) {
      if (sessions.get(sessionId as SessionId) === undefined) {
        runtimes.get(sessionId)?.dispose()
        runtimes.delete(sessionId)
      }
    }
    for (const sessionId of reviewerSessions) {
      if (sessions.get(sessionId as SessionId) === undefined) reviewerSessions.delete(sessionId)
    }
  }

  const off = ctx.on('session/event', (session, event) => {
    prune()
    if (reviewerSessions.has(session.id)) return
    const cwd = session.header.cwd
    switch (event.type) {
      case 'turn/start': {
        const runtime = runtimeFor(session.id, cwd)
        runtime?.handleTurnStart({ cwd })
        break
      }
      case 'user/message': {
        const runtime = runtimes.get(session.id)
        if (!runtime) break
        const source = (event.data as { source?: { kind?: string; plugin?: string } }).source
        const text = extractMessageText(event.data)
        if (source?.kind === 'user') {
          runtime.handleUserPrompt(text ?? '', { autoFollow: false })
        } else if (source?.kind === 'plugin' && source.plugin === 'dsh-subagents') {
          runtime.handleUserPrompt(text ?? '', { autoFollow: runtime.matchesPendingAutoFollow(text ?? '') })
        }
        break
      }
      case 'assistant/message': {
        const runtime = runtimes.get(session.id)
        if (!runtime) break
        runtime.handleAssistantMessage((event.data as { message: { content: unknown } }).message)
        break
      }
      case 'tool/call': {
        const runtime = runtimes.get(session.id)
        if (!runtime) break
        const data = event.data as { callId: string; name: string }
        runtime.handleToolCall(data.callId, data.name)
        break
      }
      case 'tool/result': {
        const runtime = runtimes.get(session.id)
        if (!runtime) break
        runtime.handleToolResult({ cwd })
        const data = event.data as { message: { content: unknown }; error?: unknown; meta?: unknown }
        const block = Array.isArray(data.message.content)
          ? (data.message.content as Array<{ type?: string; toolCallId?: string }>).find((b) => b?.type === 'tool-result')
          : undefined
        runtime.handleToolResultDelta(block?.toolCallId ?? '', data.message, data.error, data.meta)
        break
      }
      case 'turn/end': {
        const runtime = runtimes.get(session.id)
        if (!runtime) break
        runtime.handleTurnEnd(event, { cwd })
        void runtime.handleAgentEnd(event, { cwd })
        break
      }
      default:
        break
    }
  })

  const handleCommand = async (invocation: { agent: Agent; rawInput: string; signal: AbortSignal }): Promise<{ kind: 'success' | 'error'; text: string }> => {
    const { agent, rawInput } = invocation
    const cwd = agent.session.header.cwd ?? process.cwd()
    const runtime = runtimeFor(agent.session.id, cwd)
    if (!runtime) return { kind: 'error', text: 'Subagent watchdog runtime is unavailable in this session.' }
    const input = rawInput.trim()
    try {
      if (!input || input === 'status') {
        return { kind: 'success', text: await buildWatchdogStatus(runtime.getSnapshot(cwd), agent, llm) }
      }
      if (input === 'recommend-model') {
        return { kind: 'success', text: await buildRecommendationText(llm, agent) }
      }
      if (input === 'check') {
        return { kind: 'success', text: await buildCheckText(runtime, agent, llm) }
      }
      if (input === 'on' || input === 'off') {
        const enabled = input === 'on'
        const settingsPath = writeUserWatchdogEnabled(enabled, deps.home)
        const snapshot = runtime.getSnapshot(cwd)
        return {
          kind: 'success',
          text: [
            `Subagent watchdog ${boolLabel(enabled)} saved to user settings.`,
            `Updated: ${settingsPath}`,
            `Main now: ${boolLabel(snapshot.enabled)}${snapshot.sessionOverride !== undefined ? ` (session override ${boolLabel(snapshot.sessionOverride)})` : ''}`,
          ].join('\n'),
        }
      }
      if (input === 'session on' || input === 'session off') {
        const enabled = input.endsWith('on')
        const snapshot = runtime.setSessionEnabled(enabled, cwd)
        return { kind: 'success', text: [`Subagent watchdog session override: ${boolLabel(enabled)}.`, 'No settings files were changed.', '', await buildWatchdogStatus(snapshot, agent, llm)].join('\n') }
      }
      if (input.startsWith('session model ')) {
        const rawModel = input.slice('session model '.length)
        const value = await resolveModelCommandValue(llm, agent, rawModel)
        const snapshot = value.model === null
          ? runtime.clearSessionModel(cwd)
          : runtime.setSessionModel({ model: value.model, thinking: value.thinking ?? null }, cwd)
        return { kind: 'success', text: [`Subagent watchdog session model: ${value.description}.`, 'No settings files were changed.', '', await buildWatchdogStatus(snapshot, agent, llm)].join('\n') }
      }
      if (input.startsWith('model ')) {
        const rawModel = input.slice('model '.length)
        const value = await resolveModelCommandValue(llm, agent, rawModel)
        const settingsPath = writeWatchdogModelSettings({ scope: 'user', target: { kind: 'main' }, model: value.model, thinking: value.thinking }, deps.home)
        runtime.refreshConfig(cwd)
        const snapshot = runtime.getSnapshot(cwd)
        return {
          kind: 'success',
          text: [
            `Subagent watchdog model saved: ${value.description}.`,
            `Updated: ${settingsPath}`,
            `Main now: ${boolLabel(snapshot.enabled)}`,
            value.model === null ? 'The watchdog now inherits the current session model and thinking.' : 'Run /subagents-watchdog on if the watchdog is still off.',
            '',
            await buildWatchdogStatus(snapshot, agent, llm),
          ].join('\n'),
        }
      }
      if (input.startsWith('thinking ')) {
        const rawThinking = input.slice('thinking '.length)
        const thinking = parseThinkingCommand(rawThinking)
        const settingsPath = writeWatchdogModelSettings({ scope: 'user', target: { kind: 'main' }, thinking }, deps.home)
        runtime.refreshConfig(cwd)
        return {
          kind: 'success',
          text: [
            `Subagent watchdog thinking saved: ${formatThinking(thinking ?? undefined)}.`,
            `Updated: ${settingsPath}`,
            '',
            await buildWatchdogStatus(runtime.getSnapshot(cwd), agent, llm),
          ].join('\n'),
        }
      }
      const test = parseTestCommand(input)
      if (test) {
        if (!test.text) return { kind: 'error', text: 'Usage: /subagents-watchdog test concern|blocker <text>' }
        const warning: WatchdogWarningDetails = {
          severity: test.severity,
          category: 'other',
          confidence: 'high',
          source: 'main',
          state: 'displayed',
          summary: test.text,
          evidence: `Manual /subagents-watchdog test ${test.severity} message from the main session.`,
          recommendedAction: test.severity === 'blocker'
            ? 'Verify the renderer, transcript delivery, and auto-follow policy.'
            : 'Verify the renderer and transcript delivery; decide manually whether any action is needed.',
        }
        const details = runtime.recordDisplayedWarning(warning)
        const target = ctx.get('agents')?.get(agent.session.id as SessionId)
        if (target) deliverNotice(target, formatWatchdogWarningMessageText(details), 'followup')
        return { kind: 'success', text: `Watchdog test ${test.severity} message recorded and delivered.` }
      }
      return {
        kind: 'error',
        text: `Usage: /subagents-watchdog [status|on|off|session on|session off|recommend-model|model recommended|model <provider/model[:thinking]>|model inherit|thinking ${THINKING_LEVELS.join('|')}|thinking inherit|session model recommended|check|test concern <text>|test blocker <text>]`,
      }
    } catch (error) {
      return { kind: 'error', text: `Subagent watchdog\n\n${messageFromError(error)}` }
    }
  }

  return {
    runtimeFor,
    handleCommand,
    dispose: () => {
      off()
      for (const runtime of runtimes.values()) runtime.dispose()
      runtimes.clear()
    },
  }
}

function extractMessageText(message: { content: unknown }): string | undefined {
  const content = message.content
  if (Array.isArray(content)) {
    const texts = content
      .filter((block): block is Record<string, unknown> => typeof block === 'object' && block !== null && block['type'] === 'text')
      .map((block) => String(block['text'] ?? ''))
      .filter(Boolean)
    if (texts.length) return texts.join('\n')
  }
  return undefined
}
