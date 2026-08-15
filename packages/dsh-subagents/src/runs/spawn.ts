/**
 * 子代理启动：解析 agent → 组装请求（persona/toolFilter/agentOptions/maxDepth）
 * → ctx.subagents.start（spawn=全新 / fork=继承对话）→ 结果定稿（输出截断、
 * acceptance 报告解析、gate 验证命令、evidence 状态）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { AgentConfig, ChildRecord, RunRecord, SubagentsConfig, SubagentsParams } from '../types.ts'
import { DEFAULT_FOREGROUND_TIMEOUT_MS, DEFAULT_GATE_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_CHARS } from '../types.ts'
import { readTextFile } from '../util.ts'
import { resolveProjectRoot } from '../util.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import { refinementFile, readRefinement } from '../agents/management.ts'
import type { RunStore } from './store.ts'
import type { SessionBudgets } from './budgets.ts'
import { RunTreeBudget, depthError } from './budgets.ts'
import { computeEvidenceStatus, gateToAcceptance, inferAcceptance, parseAcceptanceReport, runVerification, type ResolvedAcceptance } from './acceptance.ts'
import { renderBridgeInstructions } from '../intercom/bridge.ts'
import type { SupervisorChannel } from '../intercom/supervisor.ts'
import { parseModelSpec } from '../llm.ts'

/** 启动子代理所需的依赖集合。 */
export interface SpawnDeps {
  ctx: Context
  config: SubagentsConfig
  registry: AgentRegistry
  store: RunStore
  budgets: SessionBudgets
  runTree: RunTreeBudget
  projectRoot: string
  supervisor: SupervisorChannel
}

/** 一次子代理启动的输入。 */
export interface SpawnOptions {
  agent: AgentConfig
  task: string
  context?: 'fresh' | 'fork'
  parent: Agent
  params: SubagentsParams
  index: number
  key?: string
  run: RunRecord
  missionId?: string
  cwd: string
  /** 调用方取消信号（工具 exec.signal）。 */
  signal: AbortSignal
  /**
   * 是否在 child 有未答复 supervisor 请求时保持 run 存活等待父回复。
   * 仅后台 run 可开启：前台 run 的工具调用阻塞父回合，等待会死锁。
   */
  supervisorWait?: boolean
}

/** 子代理启动的结果（终态 child 记录与输出）。 */
export interface SpawnResult {
  child: ChildRecord
  output: string
  stopReason?: string
  evidenceStatus?: string
  verify?: Array<{ command: string; passed: boolean; output: string }>
}

/** 组装子代理系统提示（persona）：agent 正文 + refine 覆盖层 + memory 注入。 */
export async function buildPersona(ctx: Context, agent: AgentConfig, projectRoot: string): Promise<string> {
  const parts: string[] = []
  if (agent.systemPrompt.trim()) parts.push(agent.systemPrompt.trim())
  const refinement = await readRefinement(projectRoot, agent.name)
  if (refinement) {
    const body = refinement.replace(/^# Refinement overlay.*$/m, '').trim()
    if (body) parts.push(`<dsh-subagents-refinement>\n${body}\n</dsh-subagents-refinement>`)
  }
  if (agent.memory) {
    const memoryDir = agent.memory.scope === 'project'
      ? resolveProjectRoot(projectRoot)
      : process.env.HOME ?? ''
    const memoryFile = `${memoryDir}/.dsh/subagents/agent-memory/${agent.memory.path}/MEMORY.md`
    const memory = await readTextFile(memoryFile)
    if (memory) {
      const head = memory.split('\n').slice(0, 200).join('\n')
      const canWrite = !agent.tools || agent.tools.some((tool) => ['edit', 'write', 'bash'].includes(tool))
      parts.push(canWrite
        ? `## Agent memory (${agent.memory.scope}:${agent.memory.path})\n${head}\n\nYou may append concise dated entries to MEMORY.md for this role.`
        : `## Agent memory (read-only)\n${head}`)
    }
  }
  return parts.join('\n\n')
}

/** 组装任务提示：任务文本 + bridge 指令 + acceptance 要求。 */
export function buildPrompt(
  task: string,
  opts: { agent: AgentConfig; context: 'fresh' | 'fork'; parentSessionId: string; config: SubagentsConfig; acceptance?: ResolvedAcceptance },
): string {
  const parts: string[] = [task.trim()]
  const bridge = renderBridgeInstructions({
    parentSessionId: opts.parentSessionId,
    childAgent: opts.agent.name,
    forkContext: opts.context === 'fork',
    config: opts.config,
  })
  if (bridge) parts.push(bridge)
  if (opts.acceptance && opts.acceptance.level !== 'none' && (opts.acceptance.level === 'attested' || opts.acceptance.evidence.length > 0)) {
    const evidenceLines = opts.acceptance.evidence.map((e) => `- ${e}`).join('\n')
    parts.push(`## Acceptance report

When you finish, include a fenced \`acceptance-report\` JSON block at the end of your final response with this shape:

\`\`\`acceptance-report
{
  "changedFiles": ["path/to/file"],
  "testsAddedOrUpdated": ["test/file"],
  "commandsRun": [{ "command": "npm test", "exitCode": 0 }],
  "validation": [{ "name": "build", "status": "passed" }],
  "residualRisks": ["..."],
  "noStagedFiles": true
}
\`\`\`

Required evidence keys:\n${evidenceLines || '- changedFiles\n- testsAddedOrUpdated\n- commandsRun\n- residualRisks'}
${opts.acceptance.criteria.length > 0 ? `Acceptance criteria:\n${opts.acceptance.criteria.map((c) => `- ${c}`).join('\n')}` : ''}`)
  }
  return parts.join('\n\n')
}

/** 解析 agent.model（含 provider 前缀与 thinking 后缀）为 dsh 路由。 */
export function resolveAgentModelRoute(agent: AgentConfig, config: SubagentsConfig, parentRoute?: { provider?: string; model?: string }): { provider?: string; model?: string } {
  const spec = agent.model ?? config.defaultModel
  if (!spec) return {}
  const parsed = parseModelSpec(spec)
  if (parsed.provider && parsed.model) return { provider: parsed.provider, model: parsed.model }
  if (parsed.model) {
    // 裸 model：若 parent 已有 provider 则带上，让子代理 loop 解析
    return { provider: parentRoute?.provider, model: parsed.model }
  }
  return {}
}

/**
 * 启动一个子代理并等待结果。返回终态 child 记录与输出。
 * 超时/中止通过 AbortController 传导给 ctx.subagents.start。
 */
export async function spawnChild(deps: SpawnDeps, options: SpawnOptions): Promise<SpawnResult> {
  const { ctx, config, store } = deps
  const { agent, task, parent, params, index, key, run, cwd } = options
  const forkContext = options.context === 'fork' || (options.context === undefined && agent.defaultContext === 'fork')
  const provider = forkContext ? 'fork' : 'spawn'

  // 预算
  if (!deps.runTree.charge()) {
    const usage = deps.runTree.usage
    throw new Error(`run spawn budget reached (max ${usage.limit} logical children in one run tree); launch a new run instead`)
  }
  if (!deps.budgets.spawns.charge()) {
    const usage = deps.budgets.spawns.usage
    throw new Error(`session spawn budget reached (used ${usage.used} of ${usage.effectiveLimit})`)
  }
  const depth = delegationDepthOf(parent)
  const maxDepth = agent.maxSubagentDepth ?? config.maxSubagentDepth ?? 2
  const depthBlock = depthError(depth, maxDepth)
  if (depthBlock) throw new Error(depthBlock)

  // 验收推断（gate 简写优先）
  let acceptance: ResolvedAcceptance | undefined
  let gateCommand: string | undefined
  if (params.gate && params.acceptance !== undefined) {
    throw new Error('`gate` cannot be combined with `acceptance`')
  }
  if (params.gate) {
    acceptance = gateToAcceptance(params.gate)
    gateCommand = params.gate
  } else if (params.acceptance !== false) {
    acceptance = inferAcceptance(params, agent, false).spec
  }

  // 预算与超时
  const timeoutMs = params.timeoutMs ?? params.maxRuntimeMs ?? agent.timeoutMs ?? config.timeoutMs ?? DEFAULT_FOREGROUND_TIMEOUT_MS
  const timeoutSignal = new AbortController()
  const timer = setTimeout(() => timeoutSignal.abort(new Error('subagent run timed out')), timeoutMs)
  const clearTimer = () => clearTimeout(timer)
  const onParentAbort = (): void => timeoutSignal.abort(new Error('parent call aborted'))
  options.signal.addEventListener('abort', onParentAbort, { once: true })
  const signal = AbortSignal.any([timeoutSignal.signal, options.signal])

  const child: ChildRecord = {
    index,
    key,
    agent: agent.name,
    task: task.slice(0, 4000),
    status: 'queued',
    startedAt: Date.now(),
  }
  store.addChild(run.id, child)
  store.appendEvent(run.id, { type: 'subagent.step.started', agent: agent.name, index })

  const parentSessionId = parent.session.id
  let failure: unknown
  let runHandle: Awaited<ReturnType<typeof ctx.subagents.start>> | undefined
  let output = ''
  let stopReason: string | undefined
  let toolsWarning: string | undefined
  try {
    // 部署可用工具过滤：agent 白名单中不存在的工具被移除并警告。
    // 作用域视图 = parent agent 本身（宿主范式：ctx.tools.get(name, context.scope)）
    let effectiveTools = agent.tools
    if (agent.tools) {
      const missing = agent.tools.filter((tool) => ctx.tools.get(tool, parent as never) === undefined)
      if (missing.length > 0) {
        effectiveTools = agent.tools.filter((tool) => !missing.includes(tool))
        toolsWarning = `tools unavailable in this deployment were omitted: ${missing.join(', ')}`
        store.appendEvent(run.id, { type: 'subagent.tools-filtered', agent: agent.name, missing, message: toolsWarning })
        if (effectiveTools.length === 0) {
          failure = new Error(`agent "${agent.name}" requires tools that are all unavailable in this deployment (${missing.join(', ')})`)
        }
      }
    }
    const persona = await buildPersona(ctx, agent, deps.projectRoot)
    const promptText = buildPrompt(task, {
      agent,
      context: forkContext ? 'fork' : 'fresh',
      parentSessionId,
      config,
      acceptance,
    })
    const route = resolveAgentModelRoute(agent, config, { provider: parent.options?.provider, model: parent.options?.model })

    const request = {
      label: `${agent.name} · ${task.slice(0, 60)}`,
      prompt: [{ type: 'text' as const, text: promptText }],
      parent,
      signal,
      ...(route.provider || route.model ? { agentOptions: { ...(route.provider ? { provider: route.provider } : {}), ...(route.model ? { model: route.model } : {}) } } : {}),
      ...(persona ? { persona } : {}),
      ...(effectiveTools ? { toolFilter: { allow: effectiveTools } } : {}),
      maxDepth,
    }
    try {
      runHandle = await ctx.subagents.start(provider, request as never)
    } catch (error) {
      failure = error
    }
    if (runHandle) {
      try {
        child.runId = runHandle.id
        child.localAgent = runHandle.localAgent
        child.status = 'running'
        store.updateChild(run.id, index, { runId: runHandle.id, status: 'running' })
        store.appendEvent(run.id, { type: 'subagent.child.started', agent: agent.name, runId: runHandle.id })

        const result = await runHandle.result
        stopReason = result.stopReason
        output = result.output
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => (block as { text: string }).text)
          .join('')
      } catch (error) {
        failure = error
      }
    }
    if (toolsWarning) store.appendEvent(run.id, { type: 'subagent.tools-filtered-warning', message: toolsWarning })
    if (toolsWarning && runHandle) {
      // 警告写入 child 提示，供结果可见
      child.task = `${child.task}

[note] ${toolsWarning}`
    }
  } finally {
    // 无论成功/异常都清除超时定时器与父信号监听（顺序敏感清理放同一处）
    clearTimer()
    options.signal.removeEventListener('abort', onParentAbort)
  }

  // supervisor 感知（缺陷 #N2）：child 回合结束时仍有未答复的 supervisor 请求
  // （contact_supervisor 后等待父决策）→ 任务并未完成：run 不得终结、child 不得
  // dispose，保留在线等父回复（followup 唤醒）；pending 清空后的回合结束才定稿。
  // 仅后台 run（supervisorWait）启用：前台工具调用阻塞父回合，等待会死锁。
  const childSessionId = runHandle?.id
  const pendingForChild = childSessionId
    ? deps.supervisor.pending(parentSessionId).filter((request) => request.childSessionId === childSessionId)
    : []
  if (options.supervisorWait === true && pendingForChild.length > 0 && runHandle?.localAgent) {
    child.awaitingSupervisor = true
    store.updateChild(run.id, index, { awaitingSupervisor: true })
    store.appendEvent(run.id, { type: 'subagent.awaiting-supervisor', agent: agent.name, index })
    const resolution = await waitForSupervisorResolution(deps, runHandle.localAgent, parentSessionId, childSessionId!, timeoutMs)
    child.awaitingSupervisor = false
    if (resolution === 'resolved') {
      // 父回复已被 child 消费：收集唤醒后回合的最终输出
      const resumed = readLatestAssistantOutput(deps.ctx, childSessionId!)
      if (resumed && resumed.trim()) output = resumed
      stopReason = 'completed'
    } else if (resolution === 'disposed') {
      stopReason = 'aborted'
    } else {
      stopReason = 'timed out waiting for supervisor reply'
    }
    store.appendEvent(run.id, { type: 'subagent.supervisor-resolved', agent: agent.name, index, resolution })
  }

  // 定稿 child 记录
  const maxChars = params.maxOutput?.maxChars ?? DEFAULT_MAX_OUTPUT_CHARS
  const truncated = output.length > maxChars ? `${output.slice(0, maxChars)}\n…[truncated]` : output
  const completed = failure === undefined && stopReason === 'completed'
  const report = completed && acceptance ? parseAcceptanceReport(truncated) : undefined

  let verify: Array<{ command: string; passed: boolean; output: string }> = []
  let evidenceStatus: string | undefined
  if (completed && gateCommand) {
    const result = await runVerification(gateCommand, cwd, deps.config.gateTimeoutMs ?? DEFAULT_GATE_TIMEOUT_MS)
    verify = [{ command: gateCommand, passed: result.passed, output: result.output.slice(0, 2000) }]
    if (!result.passed) {
      child.status = 'failed'
      child.stopReason = `gate verification failed: ${result.error ?? result.output.slice(0, 500)}`
      store.appendOutput(run.id, index, `[gate] ${gateCommand}\n${result.output}\n`)
    } else {
      store.appendOutput(run.id, index, `[gate] ${gateCommand} → passed\n`)
    }
  }
  if (completed && acceptance) {
    evidenceStatus = computeEvidenceStatus(acceptance, report, verify, { required: acceptance.review?.required, reviewed: false })
  }

  if (child.status !== 'failed') {
    if (timeoutSignal.signal.aborted) {
      child.status = 'timed_out'
      child.stopReason = 'subagent run timed out'
    } else {
      child.status = completed ? 'completed' : stopReason === 'aborted' ? 'stopped' : 'failed'
      child.stopReason = stopReason
    }
  }
  child.output = toolsWarning ? `[note] ${toolsWarning}\n\n${truncated}` : truncated
  child.endedAt = Date.now()
  child.evidenceStatus = evidenceStatus
  child.resumable = true

  if (failure !== undefined && !signal.aborted) {
    child.stopReason = `error: ${failure instanceof Error ? failure.message : String(failure)}`
  }

  if (runHandle) {
    try {
      await runHandle.dispose()
    } catch (error) {
      store.appendEvent(run.id, { type: 'subagent.child.dispose-failed', error: String(error) })
    }
    child.localAgent = undefined
  }

  store.finishChild(run.id, index, child)
  store.appendEvent(run.id, { type: 'subagent.step.completed', agent: agent.name, index, status: child.status, runId: child.runId })
  return { child, output: truncated, stopReason, evidenceStatus, verify }
}

/** supervisor 等待的终局。 */
export type SupervisorResolution = 'resolved' | 'timeout' | 'disposed'

/**
 * 等待 supervisor 决策收敛：child 在等父回复期间保持在线（不 dispose）。
 * 每次回合结束（agent idle）时检查该 child 的 pending：清空（父回复已被
 * 消费）即视为最终完成；child 被外部销毁或超时则分别返回 disposed / timeout。
 */
export async function waitForSupervisorResolution(
  deps: SpawnDeps,
  childAgent: Agent,
  parentSessionId: string,
  childSessionId: string,
  timeoutMs: number,
): Promise<SupervisorResolution> {
  const { ctx, supervisor } = deps
  const pendingForChild = (): number => supervisor.pending(parentSessionId).filter((request) => request.childSessionId === childSessionId).length
  return new Promise<SupervisorResolution>((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const disposers: Array<() => void> = []
    const settle = (value: SupervisorResolution): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      for (const dispose of disposers) dispose()
      resolve(value)
    }
    disposers.push(ctx.on('agent/status', (payload: { agent: unknown; status: string }) => {
      if (payload.agent !== childAgent || payload.status !== 'idle') return
      if (pendingForChild() === 0) settle('resolved')
    }))
    disposers.push(ctx.on('agent/disposed', (payload: { agent: unknown }) => {
      if (payload.agent === childAgent) settle('disposed')
    }))
    timer = setTimeout(() => settle('timeout'), timeoutMs)
  })
}

/** 从 child session 的派生消息面读取最后一条非空 assistant 输出。 */
function readLatestAssistantOutput(ctx: Context, childSessionId: string): string | undefined {
  const sessions = ctx.get('sessions')
  const session = sessions?.get(childSessionId as never)
  if (!session || typeof (session as { deriveMessages?: unknown }).deriveMessages !== 'function') return undefined
  const messages = (session as { deriveMessages: () => Array<{ role: string; content?: Array<{ type: string; text?: string }> }> }).deriveMessages()
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]!
    if (message.role !== 'assistant') continue
    const text = (message.content ?? [])
      .filter((block) => block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('')
    if (text.trim()) return text
  }
  return undefined
}

export type { ResolvedAcceptance }
