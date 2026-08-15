/**
 * Supervisor 通道（intercom）：子代理通过 `contact_supervisor` 向父会话发
 * 请求；父会话通过 `subagents_supervisor` 查看/回复。通知通过 agent.followup
 * 送达（对应 pi-subagents 的 native supervisor channel）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { deliverNotice } from './deliver.ts'
import { randomUUID } from 'node:crypto'
import type { SupervisorRequest } from '../types.ts'

/** 每个父会话保留的请求条数上限（超出裁剪已回复的旧条目）。 */
const MAX_REQUESTS_PER_PARENT = 100
/** 离线子代理的暂存回复条数上限。 */
const MAX_QUEUED_REPLIES = 50

/** SupervisorChannel 的构造依赖。 */
export interface SupervisorDeps {
  ctx: Context
  /** 子代理会话 → 父会话归属查询（优先运行存储，其次 session header）。 */
  parentOf?: (childSessionId: string) => { parentSessionId: string; agent: string } | undefined
}

/** 子代理 ↔ 父会话的请求/回复通道（请求按父会话隔离，Map 有界）。 */
export class SupervisorChannel {
  private readonly requests = new Map<string, SupervisorRequest[]>()
  private readonly replyQueues = new Map<string, string[]>() // parentSessionId → pending replies for child

  constructor(private readonly deps: SupervisorDeps) {}

  /** 子代理会话 → 父会话。 */
  parentOf(childSessionId: string): { parentSessionId: string; agent: string } | undefined {
    const custom = this.deps.parentOf?.(childSessionId)
    if (custom) return custom
    // 兼容非本插件启动的子代理：读 session header parentSession
    const session = this.deps.ctx.get('sessions')?.get(childSessionId as SessionId)
    const parentSession = session?.header.parentSession
    if (parentSession) return { parentSessionId: parentSession, agent: 'subagent' }
    return undefined
  }

  /** 子代理调用 contact_supervisor。 */
  async ask(childSessionId: string, reason: SupervisorRequest['reason'], message: string): Promise<{ id: string; error?: string }> {
    const parent = this.parentOf(childSessionId)
    if (!parent) {
      return { id: '', error: 'no supervisor context: this session was not started by dsh-subagents, so there is no parent to contact' }
    }
    const request: SupervisorRequest = {
      id: randomUUID().slice(0, 8),
      childSessionId,
      childAgent: parent.agent,
      parentSessionId: parent.parentSessionId,
      reason,
      message: message.slice(0, 4000),
      status: 'pending',
      createdAt: Date.now(),
    }
    const list = this.requests.get(parent.parentSessionId) ?? []
    list.push(request)
    // 有界：只保留每个父会话最近 100 条，优先裁剪已回复的旧请求
    if (list.length > MAX_REQUESTS_PER_PARENT) {
      const answered = list.filter((r) => r.status === 'answered')
      const overflow = list.length - MAX_REQUESTS_PER_PARENT
      for (let i = 0; i < overflow && i < answered.length; i += 1) {
        const idx = list.indexOf(answered[i]!)
        if (idx >= 0) list.splice(idx, 1)
      }
    }
    this.requests.set(parent.parentSessionId, list)

    // 通知父会话：运行中用 inject（回合内实时注入），空闲用 followup（唤醒）
    const parentAgent = this.deps.ctx.get('agents')?.get(parent.parentSessionId as SessionId)
    if (parentAgent) {
      const reasonLabel = reason === 'need_decision' ? 'needs a decision' : reason === 'interview_request' ? 'requests input' : 'progress update'
      deliverNotice(parentAgent, `[subagents supervisor] ${parent.agent} ${reasonLabel}:\n${request.message}\n\nReply with the \`subagents_supervisor\` tool ({ action: "reply", replyTo: "${request.id}", message: "..." }) or check pending requests.`)
    }
    return { id: request.id }
  }

  /** 父会话查看 pending。 */
  pending(parentSessionId: string): SupervisorRequest[] {
    return (this.requests.get(parentSessionId) ?? []).filter((r) => r.status === 'pending')
  }

  /** 父会话回复；回复经 followup 送达子代理。 */
  async reply(parentSessionId: string, requestId: string, message: string): Promise<{ ok: boolean; error?: string }> {
    const list = this.requests.get(parentSessionId)
    const request = list?.find((r) => r.id === requestId)
    if (!request) return { ok: false, error: `request ${requestId} not found for this session` }
    request.status = 'answered'
    request.reply = message
    request.answeredAt = Date.now()

    const childAgent = this.deps.ctx.get('agents')?.get(request.childSessionId as SessionId)
    if (childAgent) {
      deliverNotice(childAgent, `[subagents supervisor reply] The parent answered your request ${request.id}:\n\n${message}`)
      return { ok: true }
    }
    // 子代理已不在线：把回复暂存到队列，供下一次 resume 使用
    const queue = this.replyQueues.get(parentSessionId) ?? []
    queue.push(`${request.id}: ${message}`)
    this.replyQueues.set(parentSessionId, queue.slice(-MAX_QUEUED_REPLIES))
    return { ok: true }
  }

  /** resume 子代理时取回暂存回复。 */
  takeQueuedReplies(parentSessionId: string): string[] {
    const queue = this.replyQueues.get(parentSessionId) ?? []
    this.replyQueues.delete(parentSessionId)
    return queue
  }

  /** doctor：当前 pending 计数。 */
  stats(parentSessionId: string): { pending: number; answered: number } {
    const list = this.requests.get(parentSessionId) ?? []
    return { pending: list.filter((r) => r.status === 'pending').length, answered: list.filter((r) => r.status === 'answered').length }
  }
}
