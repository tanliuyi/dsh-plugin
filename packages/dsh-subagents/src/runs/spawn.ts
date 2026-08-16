/**
 * 子代理启动：解析 agent → 组装请求（persona/toolFilter/agentOptions/maxDepth）
 * → ctx.subagents.start（spawn=全新 / fork=继承对话）→ 结果定稿（输出截断、
 * acceptance 报告解析、gate 验证命令、evidence 状态）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { AgentConfig, ChildRecord, RunRecord, SubagentsConfig, SubagentsParams } from '../types.ts'
import { DEFAULT_FOREGROUND_TIMEOUT_MS, DEFAULT_GATE_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_CHARS } from '../types.ts'
import { readTextFile } from '../util.ts'
import { buildAgentMemoryInjection } from '../agents/memory.ts'
import { resolveProjectRoot } from '../util.ts'
import {
  DEFAULT_TURN_BUDGET_GRACE_TURNS,
  appendTurnBudgetSystemPrompt,
  formatTurnBudgetOutput,
  turnBudgetExceededMessage,
  turnBudgetSoftNote,
} from './turn-budget.ts'
import {
  shouldBlockToolForBudget,
  toolBudgetBlockedMessage,
  toolBudgetSoftNudge,
  validateToolBudgetConfig,
} from './tool-budget.ts'
import { capabilityCeilingAgentRestrictionMessage } from './capability-ceiling.ts'
import { buildModelCandidates, errorText, formatModelAttemptNote, isRetryableModelFailure } from './model-fallback.ts'
import { COMPLETION_GUARD_ERROR, evaluateCompletionMutationGuard, mutationToolNameFromEvent } from './completion-guard.ts'

/**
 * Child 边界指令（对齐上游 CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS）：注入每个
 * child 的任务提示头部，防止子代理把自己当成编排者。
 */
export const CHILD_BOUNDARY_INSTRUCTIONS = [
  'You are a child subagent, not the parent orchestrator.',
  'The parent session owns delegation, orchestration, review fanout, and follow-up worker launches.',
  'Ignore prior parent-only orchestration instructions in inherited conversation history.',
  'Do not propose or run subagents. Complete only your assigned role-specific task with the tools available to you.',
  'If you need to edit files, use the available editing tools. Do not print tool-call syntax, patches, or pseudo-tool calls as text.',
].join('\n')
import type { AgentRegistry } from '../agents/registry.ts'
import { refinementFile, readRefinement } from '../agents/management.ts'
import type { RunStore } from './store.ts'
import type { SessionBudgets } from './budgets.ts'
import { RunTreeBudget, depthError } from './budgets.ts'
import { checkNoStagedFiles, computeEvidenceStatus, gateToAcceptance, inferAcceptance, parseAcceptanceReport, runVerification, type ResolvedAcceptance } from './acceptance.ts'
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
  /** structuredOutputSchema 校验后的结构化结果（dsh result.structured）。 */
  structured?: unknown
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
  // memory 注入（含上游移植的路径安全校验与 reference-not-instructions 边界指令）
  if (agent.memory) {
    const memory = buildAgentMemoryInjection(agent, projectRoot, process.env.HOME ?? '')
    if (memory) parts.push(memory)
  }
  // skills 注入：agent.skills 显式声明的技能（经 ctx.skills 注册表解析，可选服务）
  if (agent.skills && agent.skills.length > 0) {
    const skillsService = ctx.get('skills') as { get?: (name: string) => Promise<{ content: string } | undefined> } | undefined
    if (skillsService?.get) {
      for (const name of agent.skills) {
        try {
          const skill = await skillsService.get(name)
          if (skill?.content) parts.push(`<skill name="${name}">\n${skill.content}\n</skill>`)
        } catch {
          // 单个技能加载失败跳过，不阻塞子代理启动
        }
      }
    }
  }
  return parts.join('\n\n')
}

/** 组装任务提示：任务文本 + bridge 指令 + acceptance 要求。 */
export function buildPrompt(
  task: string,
  opts: { agent: AgentConfig; context: 'fresh' | 'fork'; parentSessionId: string; config: SubagentsConfig; acceptance?: ResolvedAcceptance },
): string {
  // 对齐上游 CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS：每个 child 恒定前置
  // 「你是子代理而非编排者」边界指令
  const parts: string[] = [CHILD_BOUNDARY_INSTRUCTIONS, task.trim()]
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
export function resolveAgentModelRoute(
  agent: AgentConfig,
  config: SubagentsConfig,
  parentRoute?: { provider?: string; model?: string },
  paramsModel?: string,
): { provider?: string; model?: string } {
  // 对齐上游 applySingleAgentLaunchDefaults：params.model 是显式 child 默认覆盖，
  // 优先级高于 agent frontmatter / config.defaultModel
  const spec = paramsModel ?? agent.model ?? config.defaultModel
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

  // capability ceiling 拒绝 agent → 前置致命检查（对齐上方预算/深度抛错语义）：
  // 受限 agent 必须在 buildPersona / ctx.subagents.start 之前直接拒绝，否则仅
  // set failure 后仍会继续 start，受限请求实际执行（历史缺陷 #N3：#291 起受限
  // agent 拒绝不再晚到模型循环，而是拦在 preflight）。
  const ceiling = deps.config.capabilityCeiling
  if (ceiling) {
    const restriction = capabilityCeilingAgentRestrictionMessage(agent.name, ceiling)
    if (restriction) {
      store.appendEvent(run.id, { type: 'subagent.capability-ceiling-denied', agent: agent.name, message: restriction })
      throw new Error(restriction)
    }
  }

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
  let structured: unknown
  let stopReason: string | undefined
  let toolsWarning: string | undefined
  // turn-budget 运行期状态（对齐上游 TurnBudgetState 语义的 dsh 近似）
  let turnBudgetDisposer: (() => void) | undefined
  let turnCount = 0
  let wrapUpRequested = false
  let budgetAborted = false
  // toolBudget：工具调用计数与 soft/hard 提示状态
  let toolCallCount = 0
  let toolSoftNudged = false
  let toolHardNotified = false
  // toolTimeoutMs：per-tool 超时中止标记
  let toolTimeoutTriggered = false
  // completionGuard：观察到的写工具调用（替代上游消息流 hasMutationToolCall）
  const observedMutationTools: string[] = []
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
    // permissions.deny → toolFilter.deny（对齐上游 permissionDecision 的 deny 语义；
    // ask 需交互审批，dsh 无 per-tool 钩子，保留 allow 默认；内部协调工具不 gate）
    const deniedTools = Object.entries(deps.config.permissions.rules)
      .filter(([, decision]) => decision === 'deny')
      .map(([tool]) => tool)
      .filter((tool) => tool !== 'bash' && !['contact_supervisor', 'intercom', 'subagents'].includes(tool))
    if (deniedTools.length > 0) {
      store.appendEvent(run.id, { type: 'subagent.permissions-deny', agent: agent.name, denied: deniedTools })
    }
    // capability ceiling（对齐上游 capability-ceiling.ts）：agent 拒绝已在前置
    // preflight 检查抛错（受限请求绝不进入 buildPersona / ctx.subagents.start）；
    // 此处只做受限工具移除（allowedTools 存在时作为过滤白名单叠加在有效工具上）
    const ceiling = deps.config.capabilityCeiling
    const ceilingAllowedTools = ceiling?.allowedTools
    if (ceilingAllowedTools) {
      const removedByCeiling = (effectiveTools ?? []).filter((tool) => !ceilingAllowedTools.includes(tool))
      if (removedByCeiling.length > 0) {
        effectiveTools = (effectiveTools ?? []).filter((tool) => ceilingAllowedTools.includes(tool))
        toolsWarning = `tools not allowed by capability ceiling were omitted: ${removedByCeiling.join(', ')}`
        store.appendEvent(run.id, { type: 'subagent.capability-ceiling-tools-filtered', agent: agent.name, removed: removedByCeiling })
      }
    }
    const persona = await buildPersona(ctx, agent, deps.projectRoot)
    // turn-budget 软预算提示注入 persona（对齐上游 appendTurnBudgetSystemPrompt 注入 systemPrompt）
    const turnBudget = params.turnBudget ?? agent.turnBudget
    const personaWithBudget = turnBudget ? appendTurnBudgetSystemPrompt(persona, turnBudget) : persona
    const promptText = buildPrompt(task, {
      agent,
      context: forkContext ? 'fork' : 'fresh',
      parentSessionId,
      config,
      acceptance,
    })
    const route = resolveAgentModelRoute(agent, config, { provider: parent.options?.provider, model: parent.options?.model }, params.model)

    // 模型尝试循环（对齐上游 model-fallback：primary + fallbacks 候选，可重试
    // 失败换下一个模型重跑任务）。route.model 为空（继承 parent）时单次尝试。
    const rawCandidates = route.model ? buildModelCandidates(route.model, agent.fallbackModels) : []
    const modelCandidates: Array<string | undefined> = rawCandidates.length > 0 ? rawCandidates : [undefined]
    const attemptedModels: string[] = []
    for (const candidateModel of modelCandidates) {
      if (candidateModel) attemptedModels.push(candidateModel)
      const request = {
        label: `${agent.name} · ${task.slice(0, 60)}`,
        prompt: [{ type: 'text' as const, text: promptText }],
        parent,
        signal,
        ...(candidateModel ? { agentOptions: { ...(route.provider ? { provider: route.provider } : {}), model: candidateModel } } : route.provider ? { agentOptions: { provider: route.provider } } : {}),
        ...(personaWithBudget ? { persona: personaWithBudget } : {}),
        ...(effectiveTools ? { toolFilter: { allow: effectiveTools, ...(deniedTools.length > 0 ? { deny: deniedTools } : {}) } } : deniedTools.length > 0 ? { toolFilter: { deny: deniedTools } } : {}),
        // structuredOutputSchema → dsh 平台原生 outputSchema（review.ts 同机制）：child
        // 以符合 schema 的结构化结果收尾，结果在 result.structured 读取
        ...(params.structuredOutputSchema ? { outputSchema: params.structuredOutputSchema } : {}),
        maxDepth,
      }
      const hasNextCandidate = modelCandidates.indexOf(candidateModel) < modelCandidates.length - 1
      try {
        runHandle = await ctx.subagents.start(provider, request as never)
      } catch (error) {
        failure = error
        // 可重试模型失败（rate limit/模型不可用/网络）→ 换下一个候选
        if (hasNextCandidate && isRetryableModelFailure(errorText(error))) {
          store.appendEvent(run.id, { type: 'subagent.model-attempt-failed', agent: agent.name, index, model: candidateModel ?? '(inherit)', error: errorText(error) })
          continue
        }
        break
      }
      if (!runHandle) break
      {
      try {
        child.runId = runHandle.id
        child.localAgent = runHandle.localAgent
        child.status = 'running'
        store.updateChild(run.id, index, { runId: runHandle.id, status: 'running' })
        store.appendEvent(run.id, { type: 'subagent.child.started', agent: agent.name, runId: runHandle.id })

        // 运行期强制（对齐上游 subagent-runner）：
        // - turn-budget：全局 session/event 按 child 会话过滤 turn/start 计数；
        //   soft 到达 maxTurns 时 steer 请求 wrap-up，超过 maxTurns + graceTurns
        //   时 cancel 中止当前回合；
        // - toolBudget：tool/call 计数；soft 到达时 steer nudge，超过 hard 后对
        //   block 列表工具 steer 告知已禁止（dsh 无 per-tool 拦截，无法真正阻止）；
        // - toolTimeoutMs：tool/call 计时，超时 cancel 中止（对齐上游 per-tool
        //   定时器；豁免 wait 类工具；显式配置时生效，上游默认 fast-tool 超时
        //   未采用——dsh-agent 自身管理工具执行）；
        // - completionGuard：观察 child 会话的 tool/call，收集写工具调用，供
        //   run 完成后评估「实现类任务未做任何编辑」（替代上游消息流检测）。
        const turnBudget = params.turnBudget ?? agent.turnBudget
        const toolBudget = params.toolBudget
        const toolTimeoutMs = params.toolTimeoutMs ?? agent.toolTimeoutMs ?? config.toolTimeoutMs
        const completionGuardEnabled = agent.completionGuard !== false
        if (turnBudget || toolBudget || toolTimeoutMs || completionGuardEnabled) {
          const childSession = runHandle.id
          const localAgent = runHandle.localAgent
          const grace = turnBudget?.graceTurns ?? DEFAULT_TURN_BUDGET_GRACE_TURNS
          const toolBudgetResolved = toolBudget ? validateToolBudgetConfig(toolBudget).budget : undefined
          const toolTimers = new Map<string, ReturnType<typeof setTimeout>>()
          const toolTimeoutExempt = new Set(['contact_supervisor', 'intercom', 'wait'])
          turnBudgetDisposer = ctx.on('session/event', (session, event) => {
            if (session.id !== childSession) return
            // 两种执行模式的 mutation 观察（completion guard 的 attemptedMutation）：
            // - 普通模式 tool/call：直接看 data.name（edit/write/bash 等）
            // - code 模式 tool/code-dispatch：嵌套成功后按 data.name 计数，失败不计
            if (event.type === 'tool/call' || event.type === 'tool/code-dispatch') {
              const data = event.data as { callId?: string; name?: string; isError?: unknown }
              const name = data.name ?? ''
              if (completionGuardEnabled) {
                const mutating = mutationToolNameFromEvent(event as never)
                if (mutating) observedMutationTools.push(mutating)
              }
              // tool budget 与 per-tool 超时只针对「外层」真实工具调用：code 模式的外层
              // 是 run_code（非变更、非预算目标），嵌套 code-dispatch 只是完成 guard 的
              // 观察来源，不得计入外层工具预算或触发工具超时。
              if (event.type !== 'tool/call') return
              if (toolBudgetResolved && name) {
                toolCallCount += 1
                if (!toolSoftNudged && toolBudgetResolved.soft !== undefined && toolCallCount >= toolBudgetResolved.soft) {
                  toolSoftNudged = true
                  try {
                    localAgent?.steer(createUserMessage({
                      content: [{ type: 'text', text: `[subagents steer] ${toolBudgetSoftNudge(toolBudgetResolved, toolCallCount)}` }],
                      source: { kind: 'plugin', plugin: 'dsh-subagents' },
                    }))
                  } catch {
                    // nudge 失败不影响计数
                  }
                }
                if (toolCallCount > toolBudgetResolved.hard && shouldBlockToolForBudget(toolBudgetResolved, name, toolCallCount) && !toolHardNotified) {
                  toolHardNotified = true
                  try {
                    localAgent?.steer(createUserMessage({
                      content: [{ type: 'text', text: `[subagents steer] ${toolBudgetBlockedMessage(toolBudgetResolved, name, toolCallCount)}` }],
                      source: { kind: 'plugin', plugin: 'dsh-subagents' },
                    }))
                  } catch {
                    // 提示失败不影响计数
                  }
                }
              }
              // toolTimeoutMs：per-tool 计时（豁免 wait 类工具；dsh 无 per-tool
              // 取消，超时用 cancel 中止当前回合近似上游 terminateForTimeout）
              if (toolTimeoutMs && data.callId && name && !toolTimeoutExempt.has(name)) {
                const timer = setTimeout(() => {
                  toolTimers.delete(data.callId!)
                  if (toolTimeoutTriggered) return
                  toolTimeoutTriggered = true
                  try {
                    localAgent?.cancel({ kind: 'parent' })
                  } catch {
                    // cancel 失败：回合自然结束，结果仍标记超时
                  }
                }, toolTimeoutMs)
                toolTimers.set(data.callId, timer)
              }
              return
            }
            if (event.type === 'tool/result') {
              const data = event.data as { message?: { content?: unknown } }
              const block = Array.isArray(data.message?.content)
                ? (data.message.content as Array<{ type?: string; toolCallId?: string }>).find((b) => b?.type === 'tool-result')
                : undefined
              if (block?.toolCallId) {
                const timer = toolTimers.get(block.toolCallId)
                if (timer) {
                  clearTimeout(timer)
                  toolTimers.delete(block.toolCallId)
                }
              }
              return
            }
            if (event.type !== 'turn/start' || !turnBudget) return
            turnCount += 1
            if (!wrapUpRequested && turnCount >= turnBudget.maxTurns) {
              wrapUpRequested = true
              try {
                localAgent?.steer(createUserMessage({
                  content: [{ type: 'text', text: `[subagents steer] ${turnBudgetSoftNote(turnBudget, turnCount)}` }],
                  source: { kind: 'plugin', plugin: 'dsh-subagents' },
                }))
              } catch {
                // steer 失败不影响计数；hard 中止仍会触发
              }
            }
            if (!budgetAborted && turnCount > turnBudget.maxTurns + grace) {
              budgetAborted = true
              try {
                localAgent?.cancel({ kind: 'parent' })
              } catch {
                // cancel 失败：回合自然结束，结果仍标记超限
              }
            }
          })
        }

        const result = await runHandle.result
        stopReason = result.stopReason
        output = result.output
          .filter((block) => block.type === 'text' && typeof block.text === 'string')
          .map((block) => (block as { text: string }).text)
          .join('')
        if (params.structuredOutputSchema) {
          structured = (result as { structured?: unknown }).structured
        }
      } catch (error) {
        failure = error
        // 运行期失败（runHandle.result reject）：可重试模型失败 → 释放当前
        // run 并换下一个候选模型重跑（对齐上游模型尝试循环的 retry 语义）
        if (hasNextCandidate && isRetryableModelFailure(errorText(error))) {
          const failedModel = candidateModel ?? '(inherit)'
          store.appendEvent(run.id, { type: 'subagent.model-attempt-failed', agent: agent.name, index, model: failedModel, error: errorText(error) })
          try {
            await runHandle.dispose()
          } catch {
            // dispose 失败不阻塞重试
          }
          runHandle = undefined
          if (turnBudgetDisposer) {
            turnBudgetDisposer()
            turnBudgetDisposer = undefined
          }
          continue
        }
      }
      break
      }
    }
    child.attemptedModels = attemptedModels.length > 0 ? attemptedModels : undefined
    if (toolsWarning) store.appendEvent(run.id, { type: 'subagent.tools-filtered-warning', message: toolsWarning })
    if (toolsWarning && runHandle) {
      // 警告写入 child 提示，供结果可见
      child.task = `${child.task}

[note] ${toolsWarning}`
    }
  } finally {
    // 无论成功/异常都清除超时定时器、父信号监听、turn-budget 监听与 per-tool 计时器（顺序敏感清理放同一处）
    if (turnBudgetDisposer) turnBudgetDisposer()
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
  let truncated = output.length > maxChars ? `${output.slice(0, maxChars)}\n…[truncated]` : output
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
    // no-staged-files 是运行时 git 检查（对齐上游 checkNoStagedFiles）：报告的布尔
    // 只是声称，实际暂存区非空即拒绝
    if (evidenceStatus !== 'rejected' && acceptance.evidence.includes('no-staged-files')) {
      const stagedCheck = checkNoStagedFiles(cwd)
      if (!stagedCheck.passed) {
        evidenceStatus = 'rejected'
        store.appendOutput(run.id, index, `[acceptance] ${stagedCheck.message}\n`)
      }
    }
  }

  // completionGuard（对齐上游 evaluateCompletionMutationGuard）：实现类任务
  // （expectedMutation）若子代理从未调用写工具 → 触发失败。上游在 run 成功后
  // 评估（v2 语义：completionGuard !== false 即启用）；dsh 用 tool/call 事件
  // 观察替代消息流检测。
  let completionGuardTriggered = false
  if (completed && agent.completionGuard !== false) {
    const guard = evaluateCompletionMutationGuard({
      agent: agent.name,
      task,
      tools: agent.tools,
      observedMutationTools,
    })
    completionGuardTriggered = guard.triggered
    if (guard.triggered) {
      store.appendEvent(run.id, { type: 'subagent.completion-guard-triggered', agent: agent.name, index, expectedMutation: guard.expectedMutation, attemptedMutation: guard.attemptedMutation })
    }
  }

  if (child.status !== 'failed') {
    if (timeoutSignal.signal.aborted) {
      child.status = 'timed_out'
      child.stopReason = 'subagent run timed out'
    } else if (toolTimeoutTriggered) {
      // per-tool 超时中止（对齐上游 formatToolTimeoutMessage 语义）
      const toolTimeoutMs = params.toolTimeoutMs ?? agent.toolTimeoutMs ?? config.toolTimeoutMs
      child.status = 'timed_out'
      child.stopReason = `tool exceeded its timeout of ${toolTimeoutMs}ms`
      store.appendEvent(run.id, { type: 'subagent.tool-timeout', agent: agent.name, index })
    } else if (budgetAborted) {
      // turn-budget 硬中止（对齐上游 turnBudgetExceeded：输出保留部分输出）
      const turnBudget = params.turnBudget ?? agent.turnBudget
      const message = turnBudgetExceededMessage(turnBudget!, turnCount)
      child.status = 'failed'
      child.stopReason = message
      child.turnCount = turnCount
      truncated = formatTurnBudgetOutput(message, truncated)
      store.appendEvent(run.id, { type: 'subagent.turn-budget-exceeded', agent: agent.name, index, turnCount, wrapUpRequested })
    } else if (completionGuardTriggered) {
      // 对齐上游 completionGuardError：实现类任务完成但从未编辑文件
      child.status = 'failed'
      child.stopReason = COMPLETION_GUARD_ERROR
    } else if (completed && params.structuredOutputSchema && structured === undefined) {
      // 对齐上游 MISSING_STRUCTURED_OUTPUT_CALL_ERROR：声明 outputSchema 但
      // child 未以结构化结果收尾 → 失败（上游文案：must finish by calling structured_output）
      child.status = 'failed'
      child.stopReason = 'Missing structured_output call; this step has outputSchema and must finish by calling structured_output.'
      store.appendEvent(run.id, { type: 'subagent.structured-output-missing', agent: agent.name, index })
    } else {
      child.status = completed ? 'completed' : stopReason === 'aborted' ? 'stopped' : 'failed'
      child.stopReason = stopReason
    }
  }
  if (!budgetAborted && child.turnCount === undefined && turnCount > 0) child.turnCount = turnCount
  if (toolCallCount > 0) child.toolCount = toolCallCount
  child.output = toolsWarning ? `[note] ${toolsWarning}\n\n${truncated}` : truncated
  if (params.structuredOutputSchema && structured !== undefined) child.structuredOutput = structured
  child.endedAt = Date.now()
  child.evidenceStatus = evidenceStatus
  child.resumable = true

  if (failure !== undefined && !signal.aborted && !budgetAborted) {
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
  return { child, output: truncated, stopReason, evidenceStatus, verify, ...(params.structuredOutputSchema ? { structured } : {}) }
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
export function readLatestAssistantOutput(ctx: Context, childSessionId: string): string | undefined {
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
