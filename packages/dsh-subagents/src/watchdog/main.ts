/**
 * Watchdog：可选对抗性变更评审。监听 session/event 的 turn/end，若该会话
 * 工作目录是 git 仓库且本回合改变了仓库状态，用配置模型评审 diff；阻断项
 * 经 agent.followup 送达，autoFollow 队列后续修复指令。scope 监控维护有界
 * 的最近用户提示摘要。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { deliverNotice } from '../intercom/deliver.ts'
import { execFile } from 'node:child_process'
import type { SubagentsConfig } from '../types.ts'
import { loadWatchdogFile } from './actions.ts'
import { resolveLlmRoute, streamText } from '../llm.ts'

/** registerWatchdog 的依赖。 */
export interface WatchdogDeps {
  ctx: Context
  config: SubagentsConfig
  home: string
}

interface ReviewOutcome {
  blockers: string[]
  concerns: string[]
  infos: string[]
}

/** 取工作目录的 git diff（--stat + 全文，有界输出）。 */
export function gitDiff(cwd: string, maxBytes = 200_000): Promise<{ stat: string; diff: string }> {
  return new Promise((resolve) => {
    execFile('git', ['-C', cwd, 'diff', '--stat'], { timeout: 15_000, maxBuffer: 1024 * 1024 }, (statError, statStdout) => {
      if (statError) {
        resolve({ stat: '', diff: '' })
        return
      }
      execFile('git', ['-C', cwd, 'diff'], { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }, (diffError, diffStdout) => {
        if (diffError) {
          resolve({ stat: statStdout, diff: '' })
          return
        }
        resolve({ stat: statStdout, diff: diffStdout.slice(0, maxBytes) })
      })
    })
  })
}

function parseReviewJson(text: string): ReviewOutcome {
  const out: ReviewOutcome = { blockers: [], concerns: [], infos: [] }
  const extract = (key: string): string[] => {
    const regex = new RegExp(`"${key}"\\s*:\\s*\\[([\\s\\S]*?)\\]`)
    const match = text.match(regex)
    if (!match?.[1]) return []
    return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? '').filter(Boolean)
  }
  out.blockers = extract('blockers')
  out.concerns = extract('concerns')
  out.infos = extract('infos')
  if (out.blockers.length === 0 && out.concerns.length === 0 && out.infos.length === 0) {
    // 回退：把整段文本当作 concerns
    out.concerns = [text.slice(0, 2000)]
  }
  return out
}

/** 注册 watchdog：监听 session/event，回合边界/工具 cadence 触发对抗性 diff 评审。 */
export function registerWatchdog(deps: WatchdogDeps): () => void {
  const { ctx } = deps
  const scopeState = new Map<string, string[]>() // sessionId → 有界用户提示
  const attemptCount = new Map<string, number>()
  const lastBlocker = new Map<string, string>()
  const stalemateCount = new Map<string, number>()
  const toolCount = new Map<string, number>()

  const isChildSession = (sessionId: string): boolean => {
    const session = ctx.get('sessions')?.get(sessionId as SessionId)
    return session?.header.origin === 'subagent' || session?.header.parentSession !== undefined
  }

  const review = async (sessionId: string, cwd: string): Promise<void> => {
    const file = await loadWatchdogFile(deps.home)
    const effective = {
      enabled: file.enabled ?? deps.config.watchdog.enabled,
      main: file.main ?? deps.config.watchdog.main,
      scopeEnabled: file.scope?.enabled ?? deps.config.watchdog.scope.enabled,
      autoFollow: deps.config.watchdog.autoFollow,
    }
    if (!effective.enabled) return
    const child = isChildSession(sessionId)
    const modelSpec = child ? deps.config.watchdog.children.overrides[childAgentName(ctx, sessionId)]?.model ?? deps.config.watchdog.children.model : effective.main.model
    const thinking = child ? deps.config.watchdog.children.overrides[childAgentName(ctx, sessionId)]?.thinking : effective.main.thinking

    const { stat, diff } = await gitDiff(cwd)
    if (!diff.trim()) return // 本回合无仓库变更

    const agent = ctx.get('agents')?.get(sessionId as SessionId)
    if (!agent) return
    const route = await resolveLlmRoute(ctx, modelSpec, { provider: agent.options?.provider, model: agent.options?.model })
    if (!route) return

    const scopeStatement = effective.scopeEnabled ? `\nCurrent user scope (recent prompts, for drift detection):\n${(scopeState.get(sessionId) ?? []).join('\n---\n').slice(0, 4000)}` : ''
    const system = `You are the adversarial change watchdog. Review the repository diff below against the stated scope. Respond with ONLY a JSON object: {"blockers": ["..."], "concerns": ["..."], "infos": ["..."]}. Blockers are critical issues that must be resolved before proceeding; concerns are risks or improvements; infos are minor observations. Empty arrays are fine.`
    const text = await streamText(ctx, {
      provider: route.provider,
      model: route.model,
      reasoningEffort: typeof thinking === 'string' ? thinking : undefined,
      system,
      user: `Changed files:\n${stat.slice(0, 4000)}\n\nDiff:\n${diff.slice(0, 60_000)}${scopeStatement}`,
      maxTokens: 2000,
    })
    if (!text) return
    const outcome = parseReviewJson(text)
    if (outcome.blockers.length === 0 && outcome.concerns.length === 0) return

    const summary = outcome.blockers.length > 0
      ? `Watchdog found ${outcome.blockers.length} blocker(s):\n${outcome.blockers.map((b) => `- ${b}`).join('\n')}`
      : `Watchdog concerns:\n${outcome.concerns.map((c) => `- ${c}`).join('\n')}`
    const notice = `${summary}${outcome.concerns.length && outcome.blockers.length ? `\n\nConcerns:\n${outcome.concerns.map((c) => `- ${c}`).join('\n')}` : ''}`

    // autoFollow：阻断项队列后续修复指令
    const follow = effective.autoFollow
    const key = outcome.blockers.join(' | ')
    if (outcome.blockers.length > 0) {
      const attempts = attemptCount.get(sessionId) ?? 0
      if (follow.blockers && attempts < (follow.maxAttempts ?? 3)) {
        const stale = lastBlocker.get(sessionId) === key
        const repeats = stale ? (stalemateCount.get(sessionId) ?? 0) + 1 : 1
        stalemateCount.set(sessionId, repeats)
        lastBlocker.set(sessionId, key)
        if (repeats > (follow.stalemateRepeats ?? 3)) {
          // 相同的阻断反复出现：停止自动跟进
        } else {
          attemptCount.set(sessionId, attempts + 1)
          deliverNotice(agent, `[watchdog auto-follow ${attempts + 1}/${follow.maxAttempts}] Address this blocker, then run focused validation:\n${outcome.blockers.map((b) => `- ${b}`).join('\n')}`)
          return
        }
      }
    }
    deliverNotice(agent, `[watchdog] ${notice}`)
  }

  const off = ctx.on('session/event', (session, event) => {
    // scope 监控：收集用户消息文本
    if (event.type === 'user/message') {
      const text = extractMessageText(event.data)
      if (text) {
        const list = scopeState.get(session.id) ?? []
        list.push(text.slice(0, 2000))
        scopeState.set(session.id, list.slice(-8))
      }
    }
    if (event.type === 'turn/end') {
      const cwd = session.header.cwd
      if (!cwd) return
      void review(session.id, cwd)
    }
    if (event.type === 'tool/result') {
      const count = (toolCount.get(session.id) ?? 0) + 1
      toolCount.set(session.id, count)
      const cadence = deps.config.watchdog.cadence.everyNTools
      if (cadence && count % cadence === 0) {
        const cwd = session.header.cwd
        if (cwd) void review(session.id, cwd)
      }
    }
  })
  return off
}

function childAgentName(ctx: Context, sessionId: string): string {
  // 由运行存储回填的 child agent 名不在这里维护；用 session id 尾部兜底
  const session = ctx.get('sessions')?.get(sessionId as SessionId)
  return session?.header.id.slice(0, 8) ?? 'child'
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
