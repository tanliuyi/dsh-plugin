/**
 * Slash 命令（ctx.commands，可选服务）：/run、/parallel-review、/review-loop、
 * /parallel-research、/gather-context-and-clarify、/parallel-cleanup、
 * /subagents-fleet、/subagents-stop、/subagents-doctor、/subagents-guide、
 * /subagents-models、/subagents-refine、/subagents-watchdog。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import type { SubagentsDeps } from '../runs/execution.ts'
import { executeSubagents, type SessionState } from '../runs/execution.ts'
import { guide } from '../guide.ts'
import { doctor } from '../doctor.ts'
import { formatModelMapping } from '../agents/models.ts'
import { loadPromptTemplate } from '../runs/workflow.ts'
import { resolveProjectRoot } from '../util.ts'

export interface CommandRegistrar {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: { agent: import('@deepseek-ai/dsh-agent').Agent; rawInput: string; signal: AbortSignal }) => CommandResult | Promise<CommandResult>
  }): () => void
}

/** 渲染包内 prompt 模板并作为用户消息投递给 agent。 */
async function schedulePromptTurn(ctx: Context, agent: import('@deepseek-ai/dsh-agent').Agent, templateName: string, rawInput: string, deps: SubagentsDeps): Promise<void> {
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  const packageDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts')
  const template = (await loadPromptTemplate(`package:${templateName}`, { package: packageDir, user: '', project: '' })) ?? ''
  const invocation = rawInput.trim() ? `\n\nAdditional scope from the slash command invocation:\n${rawInput.trim()}` : ''
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: `${template}${invocation}` }],
    source: { kind: 'plugin', plugin: 'dsh-subagents' },
  }))
}

export function registerSlashCommands(ctx: Context, deps: SubagentsDeps, sessionState: SessionState): () => void {
  const commands = ctx.get('commands') as CommandRegistrar | undefined
  if (!commands) return () => {}
  const disposers: Array<() => void> = []

  const register = (name: string, description: string, handler: (invocation: { agent: import('@deepseek-ai/dsh-agent').Agent; rawInput: string; signal: AbortSignal }) => CommandResult | Promise<CommandResult>, input?: { hint: string }): void => {
    try {
      disposers.push(commands.register({ name, description, ...(input ? { input } : {}), handler }))
    } catch (error) {
      // 名称冲突等注册失败记录诊断而不是静默
      ctx.logger.warn(`[dsh-subagents] slash command /${name} registration failed: ${String(error)}`)
    }
  }

  // 提示词工作流：渲染模板并交给模型执行（subagents 工具在模型侧）
  for (const name of ['parallel-review', 'review-loop', 'parallel-research', 'gather-context-and-clarify', 'parallel-cleanup'] as const) {
    register(
      name,
      {
        'parallel-review': 'Launch parallel reviewers with distinct angles, then synthesize fixes',
        'review-loop': 'Run parent-controlled worker/reviewer/fix cycles until clean (max 3 rounds)',
        'parallel-research': 'Launch parallel researcher/scout subagents for a grounded answer',
        'gather-context-and-clarify': 'Gather context with subagents, then ask clarifying questions',
        'parallel-cleanup': 'Run review-only cleanup passes after implementation',
      }[name],
      async (invocation) => {
        await schedulePromptTurn(ctx, invocation.agent, name, invocation.rawInput, deps)
        return { kind: 'success', text: `Started /${name} — the workflow prompt was sent as a user message; the model will orchestrate the subagents.` }
      },
      { hint: 'optional focus or target' },
    )
  }

  // /run <agent> [task] [--bg] [--fork]
  register('run', 'Run one subagent child: /run <agent> [task] [--bg] [--fork]', async (invocation) => {
    const trimmed = invocation.rawInput.trim()
    const match = trimmed.match(/^([\w.-]+)([\s\S]*)$/)
    if (!match?.[1]) return { kind: 'error', text: 'Usage: /run <agent> [task] [--bg] [--fork]' }
    const agent = match[1]
    let task = (match[2] ?? '').trim()
    const bg = /--bg\b/.test(task)
    const fork = /--fork\b/.test(task)
    task = task.replace(/--bg\b/g, '').replace(/--fork\b/g, '').trim()
    const result = await executeSubagents(deps, sessionState, {
      parent: invocation.agent,
      signal: invocation.signal,
      cwd: invocation.agent.session.header.cwd ?? process.cwd(),
    }, { agent, task: task || undefined, async: bg, context: fork ? 'fork' : undefined })
    return { kind: result.details.kind === 'error' ? 'error' : 'success', text: result.text.slice(0, 4000) }
  }, { hint: '<agent> [task] [--bg] [--fork]' })

  register('subagents-fleet', 'Show active subagents fleet status', async (invocation) => {
    const result = await executeSubagents(deps, sessionState, {
      parent: invocation.agent,
      signal: invocation.signal,
      cwd: invocation.agent.session.header.cwd ?? process.cwd(),
    }, { action: 'status', view: 'fleet' })
    return { kind: 'success', text: result.text }
  })

  register('subagents-stop', 'Stop an active background run: /subagents-stop [run-id]', async (invocation) => {
    const id = invocation.rawInput.trim()
    if (!id) return { kind: 'error', text: 'Usage: /subagents-stop <run-id> (find ids with /subagents-fleet or subagents({ action: "status" }))' }
    const result = await executeSubagents(deps, sessionState, {
      parent: invocation.agent,
      signal: invocation.signal,
      cwd: invocation.agent.session.header.cwd ?? process.cwd(),
    }, { action: 'stop', id })
    return { kind: result.details.kind === 'error' ? 'error' : 'success', text: result.text }
  }, { hint: '<run-id>' })

  register('subagents-doctor', 'Check whether subagents are configured correctly', async (invocation) => {
    const text = await doctor(deps, {
      parent: invocation.agent,
      signal: invocation.signal,
      cwd: invocation.agent.session.header.cwd ?? process.cwd(),
    }, sessionState)
    return { kind: 'success', text }
  })

  register('subagents-guide', 'Show dsh-subagents documentation: /subagents-guide [topic]', async (invocation) => {
    const text = await guide(invocation.rawInput.trim() || 'overview')
    return { kind: 'success', text }
  }, { hint: '[topic]' })

  register('subagents-models', 'Show the live agent → model mapping: /subagents-models [agent]', async (invocation) => {
    const text = await formatModelMapping(deps, {
      parent: invocation.agent,
      signal: invocation.signal,
      cwd: invocation.agent.session.header.cwd ?? process.cwd(),
    }, resolveProjectRoot(invocation.agent.session.header.cwd ?? process.cwd()), invocation.rawInput.trim() || undefined)
    return { kind: 'success', text }
  }, { hint: '[agent]' })

  register('subagents-refine', 'Show or create a refinement overlay: /subagents-refine <agent>', async (invocation) => {
    const agentName = invocation.rawInput.trim()
    if (!agentName) return { kind: 'error', text: 'Usage: /subagents-refine <agent> (shows the current overlay; add "propose" to generate one)' }
    if (/\bpropose\b/.test(agentName)) {
      const name = agentName.replace(/\bpropose\b/g, '').trim()
      const result = await executeSubagents(deps, sessionState, {
        parent: invocation.agent,
        signal: invocation.signal,
        cwd: invocation.agent.session.header.cwd ?? process.cwd(),
      }, { action: 'refine', agent: name })
      return { kind: 'success', text: result.text }
    }
    const result = await executeSubagents(deps, sessionState, {
      parent: invocation.agent,
      signal: invocation.signal,
      cwd: invocation.agent.session.header.cwd ?? process.cwd(),
    }, { action: 'refine.show', agent: agentName })
    return { kind: 'success', text: result.text }
  }, { hint: '<agent> [propose]' })

  register('subagents-watchdog', 'Watchdog control: /subagents-watchdog [on|off|status|session on|session off|model <id>|thinking <level>|session model <id>|recommend-model|check|test concern|blocker <text>]', async (invocation) => {
    // 完整命令面由 watchdog 控制面处理（对齐上游 register-main 命令面）
    const watchdog = deps.watchdog
    if (!watchdog) return { kind: 'error', text: 'Subagent watchdog is unavailable in this deployment.' }
    return watchdog.handleCommand(invocation)
  }, { hint: '[on|off|status|model <id>|recommend-model|check]' })

  return () => {
    for (const dispose of disposers) dispose()
  }
}
