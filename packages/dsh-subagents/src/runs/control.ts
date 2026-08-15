/**
 * 运行控制动作：interrupt / stop / resume / steer / children.list。
 * dsh 子代理为进程内 agent：interrupt 用 agent.cancel(keepInbox)，
 * stop 用 cancel + dispose，steer 用 agent.steer，resume 为带先前上下文的
 * 新启动（fallback challenge，对应 pi 的 retained-children resume 语义）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ChildRecord, RetainedChild, RunRecord } from '../types.ts'
import type { RunStore } from './store.ts'
import type { SpawnDeps } from './spawn.ts'
import { spawnChild } from './spawn.ts'
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

/** resume：以先前输出为上下文的 fallback 挑战（新子代理）。 */
export async function resumeChild(
  deps: ControlDeps,
  retained: RetainedChild,
  message: string,
  params: { signal: AbortSignal; parent: Parameters<typeof spawnChild>[1]['parent'] },
): Promise<{ text: string; ok: boolean; runId?: string }> {
  const { registry } = deps
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
