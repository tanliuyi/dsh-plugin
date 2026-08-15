/**
 * Goal mission 驱动：父会话每回合结束后，若存在空闲的 goal mission 且未达
 * token 预算，向父 agent 投递一条 needs-attention 通知（对应 pi-subagents
 * 的 goal-driver）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { MissionStore } from './store.ts'
import { deliverNotice } from '../intercom/deliver.ts'

/** goal 驱动的依赖。 */
export interface GoalDriverDeps {
  ctx: Context
  /** 按会话解析该项目根对应的 mission store。 */
  storeFor: (sessionId: string) => MissionStore
  isChild: (sessionId: string) => boolean
}

/** 从 mission 状态推导「下一个可执行动作」文案。 */
export function nextReadyAction(record: { nextReadyAction?: string; decisions: Array<{ resolution?: string }> }): string | undefined {
  if (record.nextReadyAction) return record.nextReadyAction
  const openDecision = record.decisions?.find((d) => !d.resolution)
  if (openDecision) return `an open decision needs resolution (${openDecision})`
  return 'continue the mission work with the linked runs or a new subagents call'
}

/**
 * 注册 goal 驱动：监听父会话 turn/end。
 * 每个 turn 最多一条通知（用 turn seq 去重）。
 */
export function registerGoalDriver(deps: GoalDriverDeps): () => void {
  const { ctx } = deps
  const lastNotified = new Map<string, number>()

  return ctx.on('session/event', (session, event) => {
    if (event.type !== 'turn/end') return
    if (deps.isChild(session.id)) return
    const agent = ctx.get('agents')?.get(session.id)
    if (!agent) return
    const seq = event.seq
    if (lastNotified.get(session.id) === seq) return
    void (async () => {
      try {
        const missions = await deps.storeFor(session.id).activeGoalMissions()
        for (const mission of missions) {
          // 预算耗尽 → 停止通知
          const budget = mission.budget?.tokens
          const usage = mission.usage.tokens ?? 0
          if (budget !== undefined && usage >= budget) {
            if (mission.status !== 'budget-exhausted') {
              mission.status = 'budget-exhausted'
              await deps.storeFor(session.id).save(mission)
            }
            continue
          }
          // 有活跃链接运行 → 抑制通知
          const activeRun = mission.runs.find((run) => run.status === 'running' || run.status === 'queued')
          if (activeRun) continue
          const remaining = budget !== undefined ? budget - usage : undefined
          const action = nextReadyAction(mission)
          const title = mission.title ?? mission.summary ?? mission.id
          const notice = [
            `[subagents goal] ${title}`,
            remaining !== undefined ? `Remaining token budget: ${remaining}` : '',
            `Next ready action: ${action}`,
          ].filter(Boolean).join('\n')
          lastNotified.set(session.id, seq)
          deliverNotice(agent, notice)
          return // 每回合一条
        }
      } catch {
        // goal 通知尽力而为
      }
    })()
  })
}
