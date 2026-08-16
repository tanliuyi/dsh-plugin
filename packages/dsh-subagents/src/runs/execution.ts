/**
 * 工具执行入口：单子代理 / workflowScript / action 分发。
 * 前台直接等待；后台通过 ctx.jobs 注册任务。mission 自动创建、预算、
 * 深度、intercom 通知都在这里接线。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { delegationDepthOf } from '@deepseek-ai/dsh-subagent'
import type { Details, RetainedChild, RunRecord, SubagentsConfig, SubagentsParams } from '../types.ts'
import { DEFAULT_FOREGROUND_TIMEOUT_MS, MAX_WORKFLOW_SCRIPT_LENGTH } from '../types.ts'
import { resolveProjectRoot } from '../util.ts'
import type { AgentRegistry } from '../agents/registry.ts'
import { selectAgent } from '../agents/selection.ts'
import type { SupervisorChannel } from '../intercom/supervisor.ts'
import { deliverNotice } from '../intercom/deliver.ts'
import type { ProjectServices } from '../services.ts'
import { RunStore } from './store.ts'
import { SessionBudgets, RunTreeBudget } from './budgets.ts'
import { runWorkflowScript, workflowLaneKeys, type WorkflowItem, type RunsApiResult } from './workflow.ts'
import { spawnChild, type SpawnDeps } from './spawn.ts'
import { formatResultSummary, formatStatus } from './status.ts'
import { interruptRun, listChildren, resumeChild, steerRun, stopRun } from './control.ts'
import { runAgentManagementAction } from './management-actions.ts'
import { runMissionAction } from '../missions/actions.ts'
import { runScheduleAction } from './schedule-actions.ts'
import { CompletionNotifier } from './completion-notify.ts'
import { runWatchdogAction } from '../watchdog/actions.ts'
import { guide } from '../guide.ts'
import { doctor } from '../doctor.ts'
import { formatModelMapping } from '../agents/models.ts'
import type { WatchdogController } from '../watchdog/main.ts'

/** 保留失败位置供 debug.run 诊断，同时限制持久化体积。 */
export function formatRunFailure(error: unknown, maxLength = 4_000): string {
  const text = error instanceof Error && error.stack ? error.stack : String(error)
  return text.length <= maxLength ? text : `${text.slice(0, maxLength)}\n...[stack truncated]`
}

/** 插件级依赖（index.ts 组装）。 */
export interface SubagentsDeps {
  ctx: Context
  config: SubagentsConfig
  registry: AgentRegistry
  supervisor: SupervisorChannel
  services: ProjectServices
  home: string
  /** watchdog 控制面（index.ts 在 registerWatchdog 后回填）。 */
  watchdog?: WatchdogController
}

/** 单个会话最近回合边界的折叠结果。 */
export type TurnBoundaryState = 'open' | 'closed' | 'none'

/**
 * 供折叠/水合读取的最小会话形状：只需会话 id 与不可变事件日志
 * （`@deepseek-ai/dsh-session` 的 `Session.events`）。结构化类型可让单测
 * 免启动 DSH 直接构造假会话。
 */
export interface TurnStateReader {
  id: string
  /** 不可变事件日志（末尾最新）。 */
  events: ReadonlyArray<{ type: string }>
}

/**
 * 从新到旧折叠一个会话的事件日志，返回最近的回合边界：
 * 最近的边界是 `turn/start` → `open`（回合进行中）；是 `turn/end` → `closed`；
 * 无任何边界 → `none`。仅以事件日志推断，不读 agent.status。
 */
export function latestTurnBoundary(events: ReadonlyArray<{ type: string }>): TurnBoundaryState {
  for (let i = events.length - 1; i >= 0; i--) {
    const type = events[i]!.type
    if (type === 'turn/start') return 'open'
    if (type === 'turn/end') return 'closed'
  }
  return 'none'
}

/** 会话级状态（store + 预算 + 回合跟踪），按父会话 id 懒创建。 */
export class SessionState {
  readonly stores = new Map<string, RunStore>()
  readonly budgets = new Map<string, SessionBudgets>()
  readonly runTrees = new Map<string, Map<string, RunTreeBudget>>()
  /** 是否有活跃回合（turn/start → turn/end 之间）。 */
  readonly activeTurns = new Map<string, boolean>()
  /** 后台完成通知批量器（对齐上游 completion-batcher 语义）。 */
  readonly completionNotifier = new CompletionNotifier({
    deliver: (sessionId, items, groupedText) => {
      const target = this.completionTargets.get(sessionId)
      if (!target) {
        this.logger?.(`[subagents] background completion for unknown session ${sessionId}:\n${groupedText}`)
        return
      }
      const turnOpen = this.isTurnOpen(sessionId)
      if (turnOpen) {
        // 对齐上游 triggerTurn：运行中的父会话不注入（上游仅入 transcript、
        // 不打断）；dsh 无 transcript 卡片机制 → 记日志
        this.logger?.(`[subagents] background completion withheld (parent turn open):\n${groupedText}`)
        return
      }
      deliverNotice(target.parent, groupedText, 'followup')
    },
  })
  private readonly completionTargets = new Map<string, { parent: Agent }>()

  constructor(private readonly logger?: (message: string) => void) {}

  /** 登记后台完成通知的投递目标（父 agent 对象常驻，注册一次即可）。 */
  setCompletionTarget(sessionId: string, parent: Agent): void {
    this.completionTargets.set(sessionId, { parent })
  }

  isTurnOpen(sessionId: string): boolean {
    return this.activeTurns.get(sessionId) === true
  }

  /**
   * 增量处理单个回合事件（session/event listener 路径）。
   * 与 {@link hydrate} 保持同一状态语义：turn/start 开、turn/end 关。
   */
  applyTurnEvent(sessionId: string, type: string): void {
    if (type === 'turn/start') this.activeTurns.set(sessionId, true)
    else if (type === 'turn/end') this.activeTurns.delete(sessionId)
  }

  /**
   * 从每个存活会话的事件日志重建 activeTurns（插件 apply/热重载时调用）：
   * 对每个会话折叠最近回合边界，open → active，closed/none → 清除（含陈旧 active），
   * 并移除已不存活的会话残留。只读事件日志，不依赖 agent.status。
   */
  hydrate(sessions: Iterable<TurnStateReader>): void {
    const live = new Set<string>()
    for (const session of sessions) {
      live.add(session.id)
      if (latestTurnBoundary(session.events) === 'open') this.activeTurns.set(session.id, true)
      else this.activeTurns.delete(session.id)
    }
    for (const id of [...this.activeTurns.keys()]) {
      if (!live.has(id)) this.activeTurns.delete(id)
    }
  }

  store(sessionId: string, cwd: string): RunStore {
    let store = this.stores.get(sessionId)
    if (!store) {
      store = new RunStore({ sessionId, cwd, logger: this.logger })
      this.stores.set(sessionId, store)
    }
    return store
  }

  budgetsFor(config: SubagentsConfig, sessionId: string): SessionBudgets {
    let budgets = this.budgets.get(sessionId)
    if (!budgets) {
      budgets = new SessionBudgets(config)
      this.budgets.set(sessionId, budgets)
    }
    return budgets
  }

  runTree(sessionId: string, runId: string): RunTreeBudget {
    let runs = this.runTrees.get(sessionId)
    if (!runs) {
      runs = new Map()
      this.runTrees.set(sessionId, runs)
    }
    let tree = runs.get(runId)
    if (!tree) {
      tree = new RunTreeBudget(undefined)
      runs.set(runId, tree)
    }
    return tree
  }

  clear(sessionId: string): void {
    this.stores.delete(sessionId)
    this.budgets.delete(sessionId)
    this.runTrees.delete(sessionId)
  }
}

/** 工具执行上下文（调用方 agent、取消信号与工作目录）。 */
export interface ExecContext {
  parent: Agent
  signal: AbortSignal
  cwd: string
}

function sessionStore(deps: SubagentsDeps, exec: ExecContext, state: SessionState): RunStore {
  return state.store(exec.parent.session.id, exec.cwd)
}

/** 后台执行（ctx.jobs 注册任务）。 */
/**
 * 后台执行（ctx.jobs 注册任务）。
 * @internal 仅导出供单元测试（tests/background.test.ts）：验证 work 收到
 * 独立于调用方的信号。插件公共 API 不含本函数，勿在包外使用。
 */
export async function runInBackground(
  deps: SubagentsDeps,
  exec: ExecContext,
  state: SessionState,
  label: string,
  work: (signal: AbortSignal) => Promise<void>,
): Promise<{ jobId?: string; error?: string }> {
  const jobs = deps.ctx.get('jobs')
  if (!jobs) return { error: 'background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs' }
  const budgets = state.budgetsFor(deps.config, exec.parent.session.id)
  if (!budgets.asyncCapacity.reserve()) {
    const usage = budgets.asyncCapacity.usage
    return { error: `active async run capacity reached (${usage.used}/${usage.effectiveLimit})` }
  }
  const controller = new AbortController()
  try {
    const jobId = jobs.start({
      kind: 'subagent',
      label,
      owner: exec.parent,
      run: () => ({
        cancel: (reason) => controller.abort(reason ?? 'background subagents run killed'),
        done: (async () => {
          try {
            await work(controller.signal)
            return { status: 'completed', detail: 'subagents background run finished' }
          } catch (error) {
            return { status: 'failed', detail: String(error) }
          } finally {
            budgets.asyncCapacity.release()
          }
        })(),
      }),
    })
    // 接管完成通知：pending wait 让原生 jobs reporter 视为已报告而跳过，
    // 由插件自己投递（对齐上游 notify.ts 语义）：
    // - completed → completionNotifier 批量合并（debounce 150ms / maxWait 1s），
    //   同一父会话窗口内多条合并为一条 grouped 通知；
    // - 非 completed（失败）→ 绕过批量立即单独投递；
    // - 投递时父会话有活跃回合 → withhold + 日志（上游 triggerTurn 只入
    //   transcript、不注入运行中的 agent）；空闲 → followup 唤醒。
    state.setCompletionTarget(exec.parent.session.id, exec.parent)
    void jobs.wait(jobId, 24 * 3600 * 1000, exec.parent, controller.signal)
      .then((snapshot) => {
        const text = backgroundCompletionText(state, exec.parent.session.id, jobId, snapshot)
        if (!text) return
        const run = state.stores.get(exec.parent.session.id)?.list().find((record) => record.jobId === jobId)
        const status = run?.state ?? snapshot.status
        state.completionNotifier.notify(exec.parent.session.id, { jobId, text }, status !== 'completed')
      })
      .catch(() => {})
    return { jobId }
  } catch (error) {
    budgets.asyncCapacity.release()
    return { error: String(error) }
  }
}

/**
 * 后台完成通知文本（run 记录 + job 快照）。
 * @internal 仅导出供单元测试（tests/background.test.ts）。插件公共 API 不含本函数。
 */
export function backgroundCompletionText(state: SessionState, sessionId: string, jobId: string, snapshot: { status: string; detail?: string }): string | undefined {
  if (snapshot.status === 'running') return undefined
  const run = state.stores.get(sessionId)?.list().find((record) => record.jobId === jobId)
  const agent = run?.agent ?? 'subagent'
  // 通知状态以 run 记录为准：job 的 status 只反映"后台任务未抛错"，
  // run.state 才是真实终态（后台 launch/execute 捕获错误后 finishRun('failed')
  // 而 job 仍为 completed，此前导致失败 run 误报 completed）。
  const status = run?.state ?? snapshot.status
  const lines = [`[subagents] background run ${run?.id ?? jobId} (${agent}) ${status}`]
  const output = run?.children.at(-1)?.output
  if (output) lines.push(`Output tail:\n${output.slice(-600)}`)
  lines.push('Inspect with `subagents({ action: "status" })`, read the full result with `job_output`, or stop with `subagents({ action: "stop", id })`.')
  return lines.join('\n')
}

/** 自动创建 enclosing mission（workflow 或单子代理启动）。 */
async function autoMission(deps: SubagentsDeps, params: SubagentsParams, goal: string, state: SessionState, exec: ExecContext, projectRoot: string): Promise<{ missionId?: string; warning?: string; stateFile?: string }> {
  const config = deps.config
  if (!config.missions.enabled) return {}
  if (params.mission === false) return {}
  const missions = deps.services.for(projectRoot).missions
  if (params.missionId) {
    const record = await missions.get(params.missionId)
    if (!record) return { warning: `mission ${params.missionId} not found; run proceeded without mission` }
    return { missionId: record.id, stateFile: missions.stateFile(record.id) }
  }
  if (params.mission && typeof params.mission === 'object') {
    const { validateMissionInput } = await import('../missions/actions.ts')
    const validated = validateMissionInput(params.mission as Record<string, unknown>)
    if (validated.error || !validated.normalized) return { warning: `mission validation failed: ${validated.error}; run proceeded without mission` }
    try {
      const record = await missions.create(validated.normalized)
      return { missionId: record.id, stateFile: missions.stateFile(record.id) }
    } catch (error) {
      return { warning: `mission create failed: ${String(error)}` }
    }
  }
  // 自动创建
  try {
    const record = await missions.create({ title: goal.slice(0, 120) || 'Delegated work', auto: true })
    return { missionId: record.id, stateFile: missions.stateFile(record.id) }
  } catch {
    return { warning: 'automatic mission persistence failed' }
  }
}

/** auto mission 空闲终结：run 树收尾后调用，全部 run 终态即置为 terminal。 */
async function finalizeAutoMission(deps: SubagentsDeps, run: RunRecord, projectRoot: string, status: 'completed' | 'failed'): Promise<void> {
  if (!run.missionId) return
  try {
    await deps.services.for(projectRoot).missions.finalizeIfIdle(run.missionId, status)
  } catch {
    // 自动终结失败不阻塞 run 收尾
  }
}

async function attachRunToMission(deps: SubagentsDeps, missionId: string | undefined, run: RunRecord, projectRoot: string): Promise<void> {
  if (!missionId) return
  try {
    await deps.services.for(projectRoot).missions.attachRun(missionId, {
      runId: run.id,
      agent: run.agent,
      task: run.goal ?? '',
      status: run.state,
      updatedAt: Date.now(),
    })
  } catch {
    // 自动持久化失败不阻塞
  }
}

/** 启动单个子代理（前台或后台）。 */
export async function launchSingle(deps: SubagentsDeps, state: SessionState, exec: ExecContext, params: SubagentsParams): Promise<{ text: string; details: Details; asyncStarted?: boolean }> {
  if (params.share === true) {
    return { text: 'share is not supported by the dsh port (no Gist upload); remove `share: true`', details: { kind: 'error', results: [] } }
  }
  const { ctx, registry } = deps
  const projectRoot = resolveProjectRoot(exec.cwd)
  const store = sessionStore(deps, exec, state)
  const budgets = state.budgetsFor(deps.config, exec.parent.session.id)

  // agent 解析 / 选择
  let agentConfig
  if (params.agent) {
    const resolved = await registry.resolve(params.agent, params.agentScope ?? 'both', projectRoot)
    if (resolved.error || !resolved.agent) return { text: resolved.error ?? 'agent not found', details: { kind: 'error', results: [] } }
    agentConfig = resolved.agent
  } else {
    const agents = await registry.list(params.agentScope ?? 'both', projectRoot)
    const selected = await selectAgent(ctx, params.task ?? '', agents, { agentRoute: { provider: exec.parent.options?.provider, model: exec.parent.options?.model } })
    if (selected.error || !selected.agent) return { text: selected.error ?? 'could not select an agent', details: { kind: 'error', results: [] } }
    agentConfig = selected.agent
  }

  const run = store.createRun({
    mode: 'single',
    agent: agentConfig.name,
    goal: params.task?.slice(0, 200),
    timeoutMs: params.timeoutMs ?? params.maxRuntimeMs,
  })
  const mission = await autoMission(deps, params, params.task ?? agentConfig.name, state, exec, projectRoot)
  if (mission.missionId) run.missionId = mission.missionId
  if (mission.warning) run.missionWarning = mission.warning
  await attachRunToMission(deps, run.missionId, run, projectRoot)

  const runTree = state.runTree(exec.parent.session.id, run.id)
  const spawnDeps: SpawnDeps = { ctx, config: deps.config, registry, supervisor: deps.supervisor, store, budgets, runTree, projectRoot }
  // 后台 run 才允许 supervisor 等待（前台工具调用阻塞父回合，等待会死锁）。
  // forceTopLevelAsync：深度 0 的 run 强制后台（对齐上游 applyForceTopLevelAsyncOverride）
  const asyncFlag = params.async ?? (deps.config.forceTopLevelAsync && delegationDepthOf(exec.parent) === 0)

  const launch = async (signal: AbortSignal): Promise<void> => {
    try {
      const child = await spawnChild(spawnDeps, {
        agent: agentConfig,
        task: params.task ?? '',
        context: params.context,
        parent: exec.parent,
        params,
        index: 0,
        run,
        missionId: run.missionId,
        cwd: exec.cwd,
        signal,
        supervisorWait: asyncFlag,
      })
      store.finishRun(run.id, child.child.status === 'completed' ? 'completed' : child.child.status === 'stopped' ? 'stopped' : 'failed', {
        goal: params.task?.slice(0, 200),
      })
      if (run.missionId) await deps.services.for(projectRoot).missions.updateRunStatus(run.missionId, run.id, run.state)
      await finalizeAutoMission(deps, run, projectRoot, run.state === 'completed' ? 'completed' : 'failed')
    } catch (error) {
      store.finishRun(run.id, 'failed', { stopReason: formatRunFailure(error) })
      if (run.missionId) await deps.services.for(projectRoot).missions.updateRunStatus(run.missionId, run.id, 'failed')
      await finalizeAutoMission(deps, run, projectRoot, 'failed')
    }
  }

  if (asyncFlag) {
    // 后台 run 不能复用工具调用方的 exec.signal：工具调用返回后该信号会被
    // 中止，导致 run 在启动瞬间即被取消（历史缺陷）。改用 runInBackground
    // 内部独立 controller 的信号，仅由 job cancel / 运行超时驱动中止。
    const started = await runInBackground(deps, exec, state, `subagents ${agentConfig.name}`, async (signal) => {
      await launch(signal)
    })
    if (started.error) return { text: started.error, details: { kind: 'error', results: [] } }
    if (started.jobId) run.jobId = started.jobId
    return {
      text: `started background subagents run ${run.id} (${agentConfig.name})`,
      details: { kind: 'single', runId: run.id, mode: 'single', state: 'running', agent: agentConfig.name, results: [], asyncDir: undefined },
      asyncStarted: true,
    }
  }

  await launch(exec.signal)
  const details = store.detailsOf(run)
  const childOutput = run.results
    .map((result) => (result.output?.trim() ? `\n\n${result.output.trim()}` : ''))
    .join('')
  const text = `${formatResultSummary(run)}${childOutput}${run.missionId ? `\nMission: ${run.missionId} (${run.state})` : ''}${run.missionWarning ? `\nMission warning: ${run.missionWarning}` : ''}`
  return { text, details }
}

/** 执行 workflowScript（前台或后台）。 */
export async function launchWorkflow(deps: SubagentsDeps, state: SessionState, exec: ExecContext, params: SubagentsParams): Promise<{ text: string; details: Details }> {
  const script = params.workflowScript ?? ''
  if (script.length > MAX_WORKFLOW_SCRIPT_LENGTH) return { text: `workflowScript exceeds the ${MAX_WORKFLOW_SCRIPT_LENGTH} character limit`, details: { kind: 'error', results: [] } }
  const { ctx, registry } = deps
  const projectRoot = resolveProjectRoot(exec.cwd)
  const store = sessionStore(deps, exec, state)
  const run = store.createRun({ mode: 'workflow', agent: 'workflow', goal: params.task?.slice(0, 200) ?? 'workflowScript', timeoutMs: params.timeoutMs ?? params.maxRuntimeMs })

  const mission = await autoMission(deps, params, params.task ?? 'workflow', state, exec, projectRoot)
  if (mission.missionId) run.missionId = mission.missionId
  if (mission.warning) run.missionWarning = mission.warning
  await attachRunToMission(deps, run.missionId, run, projectRoot)
  run.workflowGraph = workflowLaneKeys(script).join(', ') || undefined
  store.persist(run)

  const budgets = state.budgetsFor(deps.config, exec.parent.session.id)
  const runTree = state.runTree(exec.parent.session.id, run.id)
  const spawnDeps: SpawnDeps = { ctx, config: deps.config, registry, supervisor: deps.supervisor, store, budgets, runTree, projectRoot }
  const promptDirs = {
    package: await packagePromptsDir(),
    user: `${deps.home}/.dsh/subagents/prompts`,
    project: `${projectRoot}/.dsh/subagents/prompts`,
  }

  // 后台 workflow 的 lane 才允许 supervisor 等待（前台工具调用阻塞父回合，等待会死锁）
  const asyncFlag = params.async ?? deps.config.asyncByDefault

  let nextIndex = 0
  // 链级 usage-budget 累计（per workflow run）
  let usageAccumulator = 0
  // onSpawn 工厂：每次执行（execute）创建独立闭包，显式捕获本次执行的信号——
  // 前台为 exec.signal，后台为独立 controller 信号。spawnChild 必须与 workflow
  // 执行共用同一信号，否则后台 workflow 的 lane 会收到已中止的调用方信号
  // （工具调用返回后 exec.signal 即 abort），lane 启动即被取消。工厂形式避免
  // 跨执行共享可变状态（并发 execute 各自持有自己的信号闭包）。
  const makeOnSpawn = (signal: AbortSignal) => async (key: string, item: WorkflowItem): Promise<RunsApiResult> => {
    const agentConfig = await resolveWorkflowAgent(deps, registry, item.agent, projectRoot)
    if (!agentConfig) throw new Error(`workflow step "${key}" names unknown agent "${item.agent}"`)
    const index = nextIndex++
    const childParams: SubagentsParams = {
      ...params,
      task: item.task,
      context: params.context ?? item.context,
      gate: item.gate,
      acceptance: item.acceptance as SubagentsParams['acceptance'],
      ...(item.outputSchema ? { structuredOutputSchema: item.outputSchema } : {}),
    }
    const child = await spawnChild(spawnDeps, {
      agent: agentConfig,
      task: item.task,
      context: params.context ?? item.context ?? agentConfig.defaultContext,
      parent: exec.parent,
      params: childParams,
      index,
      key,
      run,
      missionId: run.missionId,
      cwd: exec.cwd,
      signal,
      supervisorWait: asyncFlag,
    })
    if (run.missionId) {
      await deps.services.for(projectRoot).missions.updateRunStatus(run.missionId, run.id, child.child.status, { key })
    }
    // 链级 usage-budget（对齐上游 usage-budget.ts）：workflow 跨子代理累计用量，
    // 撞 hard 即拒绝后续 child（tokens 用 tokenMeter 的 surface 启发式估算；
    // costUsd 无费用数据，记录不执行）
    if (params.usageBudget) {
      const hard = params.usageBudget.tokens?.hard
      if (hard !== undefined && typeof hard === 'number') {
        let used = usageAccumulator
        if (child.child.runId) {
          const session = ctx.get('sessions')?.get(child.child.runId as never)
          const meter = ctx.get('tokenMeter') as { measure?: (session: unknown) => { surfaceTokens?: number } } | undefined
          if (session && meter?.measure) {
            try {
              used += meter.measure(session).surfaceTokens ?? 0
            } catch {
              // 测量失败不阻塞（用量估计缺失时按 0 处理）
            }
          }
        }
        usageAccumulator = used
        if (used > hard) {
          throw new Error(`Usage budget exhausted: estimated tokens ${used} reached hard limit ${hard}.`)
        }
      }
    }
    return {
      key,
      agent: agentConfig.name,
      runId: child.child.runId,
      output: child.output,
      status: child.child.status,
      artifactPaths: {},
    }
  }

  const execute = async (signal: AbortSignal): Promise<{ value: unknown; text: string; emitted?: unknown[] }> => {
    // lane 子代理与 workflow 脚本共用同一执行信号（闭包显式捕获本次 execute 的信号）
    const onSpawn = makeOnSpawn(signal)
    // 运行级超时：vm 沙箱只约束同步段，异步挂起由该信号竞速中止
    const controller = new AbortController()
    const timeoutMs = params.timeoutMs ?? params.maxRuntimeMs ?? deps.config.timeoutMs ?? DEFAULT_FOREGROUND_TIMEOUT_MS
    const timer = setTimeout(() => controller.abort(new Error(`workflow ${run.id} timed out after ${timeoutMs}ms`)), timeoutMs)
    const clearTimer = () => clearTimeout(timer)
    try {
      const result = await runWorkflowScript({
        script,
        run,
        params,
        missionStateFile: mission.stateFile,
        promptDirs,
        onSpawn,
        signal: AbortSignal.any([signal, controller.signal]),
      })
      const failed = run.children.some((child) => child.status !== 'completed')
      store.finishRun(run.id, failed ? 'failed' : 'completed', { goal: params.task?.slice(0, 200) ?? 'workflowScript' })
      if (run.missionId) await deps.services.for(projectRoot).missions.updateRunStatus(run.missionId, run.id, run.state)
      await finalizeAutoMission(deps, run, projectRoot, failed ? 'failed' : 'completed')
      return result
    } catch (error) {
      // 脚本 reject（lane 抛错/中止/超时）也必须终结 run 与 auto mission：
      // 否则 run 永留 running、mission 永留 active（历史缺陷 #N1）。继续上抛以保留 job failed 通知。
      store.finishRun(run.id, 'failed', { stopReason: `workflow script error: ${formatRunFailure(error)}` })
      if (run.missionId) await deps.services.for(projectRoot).missions.updateRunStatus(run.missionId, run.id, 'failed')
      await finalizeAutoMission(deps, run, projectRoot, 'failed')
      throw error
    } finally {
      clearTimer()
    }
  }

  if (asyncFlag) {
    const started = await runInBackground(deps, exec, state, `subagents workflow (${run.workflowGraph ?? script.slice(0, 60)})`, async (signal) => {
      await execute(signal)
    })
    if (started.error) return { text: started.error, details: { kind: 'error', results: [] } }
    if (started.jobId) run.jobId = started.jobId
    return {
      text: `started background workflow ${run.id}${run.workflowGraph ? ` · ${run.workflowGraph}` : ''}`,
      details: { kind: 'workflow', runId: run.id, mode: 'workflow', state: 'running', agent: 'workflow', results: [] },
    }
  }

  let outcome: { value: unknown; text: string; emitted?: unknown[] }
  try {
    outcome = await execute(exec.signal)
  } catch (error) {
    store.finishRun(run.id, 'failed', { stopReason: `workflow script error: ${formatRunFailure(error)}` })
    if (run.missionId) await deps.services.for(projectRoot).missions.updateRunStatus(run.missionId, run.id, 'failed')
    await finalizeAutoMission(deps, run, projectRoot, 'failed')
    return { text: `workflow ${run.id} failed: ${String(error)}`, details: store.detailsOf(run) }
  }

  const details = store.detailsOf(run)
  const summary = formatResultSummary(run)
  const emittedText = outcome.emitted && outcome.emitted.length > 0
    ? `Emitted:\n${outcome.emitted.map((item) => typeof item === 'string' ? item : JSON.stringify(item, null, 2)).join('\n---\n').slice(0, 4000)}`
    : ''
  const text = [
    outcome.text ? `Result:\n${outcome.text.slice(0, 4000)}` : '',
    emittedText,
    summary,
    run.missionId ? `Mission: ${run.missionId} (${run.state})` : '',
    run.missionWarning ? `Mission warning: ${run.missionWarning}` : '',
  ].filter(Boolean).join('\n')
  return { text, details }
}

async function resolveWorkflowAgent(deps: SubagentsDeps, registry: AgentRegistry, name: string, projectRoot: string): Promise<NonNullable<Awaited<ReturnType<AgentRegistry['resolve']>>['agent']> | undefined> {
  const resolved = await registry.resolve(name, 'both', projectRoot)
  return resolved.agent
}

/** 包内 prompts 目录（随发布包分发）。 */
export async function packagePromptsDir(): Promise<string> {
  const { fileURLToPath } = await import('node:url')
  const path = await import('node:path')
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'prompts')
}

/** resume：以保留子代理为目标的 fallback 挑战。 */
export async function launchResume(deps: SubagentsDeps, state: SessionState, exec: ExecContext, params: SubagentsParams): Promise<{ text: string; details: Details }> {
  const store = sessionStore(deps, exec, state)
  const retained = store.retainedChildren(exec.parent.session.id).find((child) => child.runId === params.resume)
  if (!retained) {
    return { text: `retained child ${params.resume} not found (use children.list to see resumable runs)`, details: { kind: 'error', results: [] } }
  }
  const projectRoot = resolveProjectRoot(exec.cwd)
  const budgets = state.budgetsFor(deps.config, exec.parent.session.id)
  const runTree = state.runTree(exec.parent.session.id, `resume-${params.resume}`)
  // 不在此 createRun：resumeChild 内部会创建并终结 run 记录，
  // 这里重复创建会产生永不终结的幽灵 run（历史缺陷 #N3）。
  const child = await resumeChild(
    { ctx: deps.ctx, config: deps.config, registry: deps.registry, supervisor: deps.supervisor, store, budgets, runTree, projectRoot },
    retained,
    params.message ?? 'Continue the work; reconsider and make any better current-scope change.',
    { signal: exec.signal, parent: exec.parent },
  )
  const run = child.runId ? store.find(child.runId) : undefined
  const details = run ? store.detailsOf(run) : { kind: 'single', runId: child.runId, mode: 'single' as const, state: (child.ok ? 'completed' : 'failed') as never, agent: retained.agent, results: [] }
  return { text: child.text, details }
}

/** action 分发。 */
export async function dispatchAction(deps: SubagentsDeps, state: SessionState, exec: ExecContext, params: SubagentsParams): Promise<{ text: string; details: Details }> {
  const action = params.action ?? ''
  const projectRoot = resolveProjectRoot(exec.cwd)
  const store = sessionStore(deps, exec, state)

  switch (action) {
    case 'status': {
      const formatted = formatStatus(store, params.view, params.id, params.lines)
      return { text: formatted.text, details: formatted.details }
    }
    case 'fleet': {
      const formatted = formatStatus(store, 'fleet')
      return { text: formatted.text, details: formatted.details }
    }
    case 'debug.run': {
      // 对齐上游 debug.run：async run 生命周期诊断（status + 事件流剖析）
      if (!params.id) return { text: 'debug.run requires id', details: { kind: 'error', results: [] } }
      const run = store.find(params.id)
      if (!run) return { text: `run ${params.id} not found (use status to list run ids)`, details: { kind: 'error', results: [] } }
      const events = await store.readEvents(run.id, 50)
      const lines = [
        `Run ${run.id} · ${run.mode} · ${run.state}`,
        `Agent: ${run.agent} · goal: ${run.goal ?? '—'}`,
        `Started: ${new Date(run.startedAt).toISOString()}${run.endedAt ? ` · ended: ${new Date(run.endedAt).toISOString()}` : ''}`,
        `Children: ${run.children.length} · spawns: ${run.spawnCount} · tokens: ${run.usage?.tokens ?? '—'}`,
        ...(run.stopReason ? [`Stop reason: ${run.stopReason}`] : []),
        `Events (${events.length}):`,
        ...events.map((event) => `  [${event.ts ? new Date(event.ts as number).toISOString() : '—'}] ${String(event.type ?? '?')}${event.message ? ` — ${String(event.message).slice(0, 120)}` : ''}`),
      ]
      return {
        text: lines.join('\n'),
        details: { kind: 'debug', results: [], runId: run.id, state: run.state, events: events.length },
      }
    }
    case 'list':
    case 'get':
    case 'create':
    case 'update':
    case 'delete':
    case 'eject':
    case 'disable':
    case 'enable':
    case 'reset':
    case 'refine':
    case 'refine.show':
    case 'refine.rollback': {
      return runAgentManagementAction(deps, exec, params, projectRoot, state)
    }
    case 'models': {
      const mapping = await formatModelMapping(deps, exec, projectRoot, params.agent)
      return { text: mapping, details: { kind: 'models', results: [] } }
    }
    case 'guide': {
      const text = await guide(params.topic)
      return { text, details: { kind: 'guide', results: [] } }
    }
    case 'doctor': {
      const text = await doctor(deps, exec, state)
      return { text, details: { kind: 'doctor', results: [] } }
    }
    case 'interrupt': {
      if (!params.id) return { text: 'interrupt requires id', details: { kind: 'error', results: [] } }
      const result = interruptRun(store, params.id)
      return { text: result.text, details: { kind: 'control', results: [] } }
    }
    case 'stop': {
      if (!params.id) return { text: 'stop requires id', details: { kind: 'error', results: [] } }
      const result = await stopRun(store, params.id)
      // stop 只终结 run 记录；auto mission 依赖 child 回调终结，悬挂 run（无 active child）
      // 没有回调，必须在此收尾，否则 mission 永留 active（历史缺陷 #N1）。
      if (result.ok) {
        const stopped = store.find(params.id)
        if (stopped?.missionId) {
          await deps.services.for(projectRoot).missions.updateRunStatus(stopped.missionId, stopped.id, 'stopped')
          await finalizeAutoMission(deps, stopped, projectRoot, 'failed')
        }
      }
      return { text: result.text, details: { kind: 'control', results: [] } }
    }
    case 'steer': {
      if (!params.id || !params.message) return { text: 'steer requires id and message', details: { kind: 'error', results: [] } }
      const result = steerRun(store, params.id, params.message, { mode: params.mode, index: params.index })
      return { text: result.text, details: { kind: 'control', results: [] } }
    }
    case 'resume': {
      // 兼容旧字段名 `resume`（schema 与 handler 曾不一致，导致参数被静默忽略）
      const retainedId = params.id ?? params.resume
      if (!retainedId) return { text: 'resume requires id', details: { kind: 'error', results: [] } }
      return launchResume(deps, state, exec, { ...params, resume: retainedId })
    }
    case 'children.list': {
      return { text: listChildren(store, exec.parent.session.id).text, details: { kind: 'children', results: [] } }
    }
    case 'grant-spawn-budget': {
      const budgets = state.budgetsFor(deps.config, exec.parent.session.id)
      if (!params.additional) return { text: 'grant-spawn-budget requires additional (positive launches)', details: { kind: 'error', results: [] } }
      const result = budgets.spawns.grant(params.additional)
      return { text: result.ok ? `granted ${params.additional} additional spawns (used ${budgets.spawns.usage.used})` : `grant failed: ${result.error}`, details: { kind: 'budget', results: [] } }
    }
    case 'mission.create':
    case 'mission.list':
    case 'mission.show':
    case 'mission.update':
    case 'mission.resolve-decision':
    case 'mission.attach-run':
    case 'mission.close': {
      const result = await runMissionAction(deps.services.for(projectRoot).missions, {
        action,
        missionId: params.missionId,
        mission: params.mission,
        config: typeof params.config === 'string' ? params.config : (params.config as Record<string, unknown> | undefined),
        summary: params.message,
        decisionId: params['decisionId'] as string | undefined,
        runId: params.runId ?? params.id,
        missionScope: (params as { missionScope?: 'project' | 'global' }).missionScope,
        missionUpdate: params.missionUpdate,
        missionStatus: params.missionStatus,
        runMode: params.runMode,
        runStatus: params.runStatus,
      })
      return { text: result.text, details: { kind: 'mission', results: [], missionId: result.missionId, state: result.status as never } }
    }
    case 'schedule.create':
    case 'schedule.list':
    case 'schedule.show':
    case 'schedule.history':
    case 'schedule.pause':
    case 'schedule.resume':
    case 'schedule.run':
    case 'schedule.run-due':
    case 'schedule.delete': {
      const scheduleParams = action === 'schedule.create' ? { ...params, creatorSessionId: exec.parent.session.id, cwd: exec.cwd } : params
      return runScheduleAction(deps.services.for(projectRoot).schedules, scheduleParams, action)
    }
    case 'watchdog.configure':
    case 'watchdog.recommend-model':
    case 'watchdog.status':
    case 'watchdog.check': {
      return runWatchdogAction(deps, exec, params, action, projectRoot)
    }
    default: {
      const suggestions = ['status', 'list', 'guide'].includes(action) ? '' : '\n\nSuggested next steps: `status`, `list`, `guide`.'
      return {
        text: `unknown action "${action}".${suggestions}`,
        details: { kind: 'error', results: [] },
      }
    }
  }
}

/** 顶层分发：action > workflowScript > agent+task > resume > 引导。 */
export async function executeSubagents(deps: SubagentsDeps, state: SessionState, exec: ExecContext, params: SubagentsParams): Promise<{ text: string; details: Details }> {
  if (params.action) return dispatchAction(deps, state, exec, params)
  if (params.workflowScript) return launchWorkflow(deps, state, exec, params)
  // agent 可省略：由路由（LLM + 启发式）选择
  if (params.task !== undefined) return launchSingle(deps, state, exec, params)
  if (params.resume) return launchResume(deps, state, exec, params)
  if (params.agent && params.task === undefined) {
    return { text: '`agent` requires `task` (or use `action` for management/control actions)', details: { kind: 'error', results: [] } }
  }
  return {
    text: 'No execution mode selected. Use one of:\n- `{ agent, task }` for one child\n- `{ workflowScript }` for a scripted workflow\n- `{ action }` for management/control (see `guide` for topics)',
    details: { kind: 'error', results: [] },
  }
}

export { delegationDepthOf }
