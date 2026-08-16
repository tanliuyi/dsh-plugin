/**
 * 运行控制动作：interrupt / stop / resume / steer / children.list。
 * dsh 子代理为进程内 agent：interrupt 用 agent.cancel(keepInbox)，
 * stop 用 cancel + dispose，steer 用 agent.steer，resume 为带先前上下文的
 * 新启动（fallback challenge，对应 pi 的 retained-children resume 语义）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ChildRecord, RetainedChild, RunRecord } from '../types.ts'
import { DEFAULT_FOREGROUND_TIMEOUT_MS } from '../types.ts'
import type { RunStore } from './store.ts'
import type { SpawnDeps } from './spawn.ts'
import { readLatestAssistantOutput, spawnChild } from './spawn.ts'
import type { AgentConfig } from '../types.ts'

/** 运行控制动作的依赖（在 SpawnDeps 基础上需要 ctx）。 */
export interface ControlDeps extends SpawnDeps {
  ctx: Context
}

/** interrupt：取消当前回合，保留 inbox（队列中的后续消息）。 */
export function interruptRun(store: RunStore, id: string): { text: string; ok: boolean } {
  const run = store.find(id)
  if (!run) return { text: `run ${id} not found`, ok: false }
  if (!run.active) return { text: `run ${id} is not active (${run.state})`, ok: false }
  const active = run.children.filter((child) => child.status === 'running' || child.status === 'queued')
  if (active.length === 0) return { text: `run ${id} has no active children`, ok: false }
  for (const child of active) {
    if (child.localAgent) child.localAgent.cancel({ kind: 'parent' }, { keepInbox: true })
  }
  store.appendEvent(run.id, { type: 'subagent.control.interrupted', runId: id })
  return { text: `interrupted ${active.length} child(ren) of run ${id}`, ok: true }
}

/** stop：取消并终结（顶层后台运行）。 */
export async function stopRun(store: RunStore, id: string): Promise<{ text: string; ok: boolean }> {
  const run = store.find(id)
  if (!run) return { text: `run ${id} not found`, ok: false }
  if (!run.active) return { text: `run ${id} is not active (${run.state})`, ok: false }
  const active = run.children.filter((child) => child.status === 'running' || child.status === 'queued')
  for (const child of active) {
    if (child.localAgent) child.localAgent.cancel({ kind: 'parent' })
    if (child.run) {
      try {
        await child.run.dispose()
      } catch (error) {
        // dispose 失败记入事件流而不是静默
        store.appendEvent(run.id, { type: 'subagent.child.dispose-failed', error: String(error) })
      }
    }
  }
  store.finishRun(run.id, 'stopped', { stopReason: 'stopped by parent' })
  store.appendEvent(run.id, { type: 'subagent.run.stopped', runId: id })
  return { text: `stopped run ${id} (${active.length} active child(ren) cancelled)`, ok: true }
}

/** steer：向运行中的子代理投递指导消息。 */
export function steerRun(
  store: RunStore,
  id: string,
  message: string,
  opts: { mode?: 'steer' | 'follow_up' | 'auto'; index?: number },
): { text: string; ok: boolean; deliveryStatus?: 'delivered' | 'queued' } {
  const run = store.find(id)
  if (!run) return { text: `run ${id} not found`, ok: false }
  const target = opts.index !== undefined ? run.children.find((child) => child.index === opts.index) : run.children.at(-1)
  if (!target) return { text: `run ${id} has no child at index ${opts.index ?? 'last'}`, ok: false }
  if (opts.mode === 'follow_up') {
    // 已完成子代理：记录为下次 resume 的简报
    target.followUpBrief = message
    store.updateChild(run.id, target.index, { followUpBrief: message })
    return { text: `queued follow-up for child ${target.index} of run ${id} (delivered on next resume)`, ok: true, deliveryStatus: 'queued' }
  }
  const agent = target.localAgent ?? store.childByRunId(target.runId ?? '')?.localAgent
  if (!agent || agent.status !== 'running') {
    target.followUpBrief = message
    store.updateChild(run.id, target.index, { followUpBrief: message })
    return { text: `child ${target.index} is not running; queued as follow-up for its next resume`, ok: true, deliveryStatus: 'queued' }
  }
  agent.steer(createUserMessage({
    content: [{ type: 'text', text: `[subagents steer] ${message}` }],
    source: { kind: 'plugin', plugin: 'dsh-subagents' },
  }))
  store.appendEvent(run.id, { type: 'subagent.steer.delivered', runId: id, index: target.index })
  return { text: `steered child ${target.index} of run ${id}`, ok: true, deliveryStatus: 'delivered' }
}

/** resume：优先续跑原 child 会话（对齐上游 retained-resume：保留中断回合的完整
 *  会话状态，经 subagents.followup 唤醒）；child 会话不可用（已 dispose/超时）
 *  时回退为带先前输出的 fallback challenge（新子代理）。 */
export async function resumeChild(
  deps: ControlDeps,
  retained: RetainedChild,
  message: string,
  params: { signal: AbortSignal; parent: Parameters<typeof spawnChild>[1]['parent'] },
): Promise<{ text: string; ok: boolean; runId?: string }> {
  const { ctx, registry } = deps
  const timeoutMs = deps.config.timeoutMs ?? DEFAULT_FOREGROUND_TIMEOUT_MS
  const childSessionId = retained.runId

  // 1) 真续跑：child 会话仍在 agents 注册表中
  if (childSessionId) {
    const childAgent = ctx.get('agents')?.get(childSessionId as never)
    const subagents = ctx.get('subagents')
    if (childAgent && subagents) {
      const previous = readLatestAssistantOutput(ctx, childSessionId)
      const resumeText = [
        `Resume from your previous attempt${retained.reason ? ` (${retained.reason})` : ''}.`,
        '',
        `Previous task:\n${retained.task}`,
        '',
        previous ? `Your previous result ended with:\n${previous.slice(0, 4000)}\n` : '',
        `Follow-up from the parent: ${message}`,
      ].filter(Boolean).join('\n')
      try {
        await subagents.followup(params.parent, childSessionId as never, [{ type: 'text', text: resumeText }], {
          source: { kind: 'plugin', plugin: 'dsh-subagents' },
          signal: params.signal,
        })
        const outcome = await waitForResumeOutput(ctx, childAgent, previous, timeoutMs, params.signal)
        if (outcome.status === 'completed' && outcome.output) {
          const run = deps.store.createRun({ mode: 'single', agent: retained.agent, missionId: retained.missionId })
          deps.store.finishRun(run.id, 'completed', { goal: `resume ${retained.agent}` })
          deps.store.appendEvent(run.id, { type: 'subagent.run.resumed', runId: childSessionId, retainedKey: retained.key ?? null })
          return {
            text: `resumed ${retained.agent} (continued the original child session)\n${outcome.output.slice(0, 4000)}`,
            ok: true,
            runId: run.id,
          }
        }
        if (outcome.status === 'aborted') {
          return { text: `resume of ${retained.agent} was aborted`, ok: false }
        }
      } catch (error) {
        // followup 失败 → 回退 fallback challenge
        // （错误记录到 run 事件流需要 run id；此处保留 fallback 语义即可）
      }
    }
  }

  // 2) fallback challenge（新子代理，带先前输出）
  const resolved = await registry.resolve(retained.agent, 'both', deps.projectRoot)
  if (!resolved.agent) return { text: `cannot resume ${retained.agent}: ${resolved.error}`, ok: false }
  const agent: AgentConfig = resolved.agent
  const previous = retained.output.slice(0, 8000)
  const task = [
    `You previously completed this task (labeled ${retained.key ?? `index ${retained.index}`}):`,
    '',
    retained.task,
    '',
    previous ? `Your previous result ended with:\n${previous}\n` : '',
    `Follow-up from the parent: ${message}`,
  ].filter(Boolean).join('\n')

  const run = deps.store.createRun({ mode: 'single', agent: agent.name, missionId: retained.missionId })
  const child = await spawnChild(deps, {
    agent,
    task,
    parent: params.parent,
    params: {},
    index: 0,
    run,
    cwd: deps.projectRoot,
    signal: params.signal,
    missionId: retained.missionId,
  })
  deps.store.finishRun(run.id, child.child.status === 'completed' ? 'completed' : 'failed', { goal: `resume ${retained.agent}` })
  return {
    text: `resumed ${retained.agent} (fallback challenge: previous attempt was ${retained.reason ?? 'completed'})\n${child.output.slice(0, 4000)}`,
    ok: child.child.status === 'completed',
    runId: run.id,
  }
}

/**
 * 等待续跑回合完成：child 从 running 回到 idle 且出现新输出即完成；
 * 超时返回 timeout，信号中止返回 aborted。
 */
async function waitForResumeOutput(
  ctx: Context,
  childAgent: import('@deepseek-ai/dsh-agent').Agent,
  prevOutput: string | undefined,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<{ output?: string; status: 'completed' | 'timeout' | 'aborted' }> {
  const deadline = Date.now() + timeoutMs
  let sawRunning = false
  for (;;) {
    if (signal.aborted) return { status: 'aborted' }
    if (Date.now() > deadline) return { status: 'timeout' }
    const status = childAgent.status
    if (status === 'running') sawRunning = true
    const output = readLatestAssistantOutput(ctx, childAgent.session.id)
    if (sawRunning && status === 'idle' && output && output !== prevOutput) {
      return { output, status: 'completed' }
    }
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

/** children.list：保留子代理（最多 10 个）。 */
export function listChildren(store: RunStore, sessionId: string): { text: string } {
  const children = store.retainedChildren(sessionId)
  if (children.length === 0) return { text: 'No retained children from this session.' }
  const lines = children.map((child) => {
    const state = child.resumable ? 'resumable' : 'not resumable'
    return `- ${child.runId} ${child.agent}${child.key ? ` (${child.key})` : ''} ${state}${child.reason ? ` — ${child.reason}` : ''}`
  })
  return { text: `Retained children:\n${lines.join('\n')}` }
}

/** 运行树当前活跃子代理。 */
export function activeChildren(run: RunRecord): ChildRecord[] {
  return run.children.filter((child) => child.status === 'running' || child.status === 'queued')
}
