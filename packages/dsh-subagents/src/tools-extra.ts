/**
 * 附加工具：contact_supervisor（子代理 → 父会话）、subagents_supervisor
 * （父会话查看/回复）、subagents_wait（等待活跃运行变化）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { SupervisorChannel } from './intercom/supervisor.ts'
import type { SessionState } from './runs/execution.ts'

/** wait 工具单次轮询间隔（毫秒）。 */
const WAIT_POLL_MS = 1000
/** wait 工具阻塞等待上限（毫秒）。 */
const WAIT_MAX_MS = 10 * 60_000

/** 可中止的睡眠：signal 中止时立即清除定时器并返回。 */
async function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const finish = (): void => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }
    const onAbort = (): void => {
      if (timer) clearTimeout(timer)
      finish()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    timer = setTimeout(finish, ms)
  })
}

/** 子代理询问父会话。 */
export function registerContactSupervisorTool(ctx: Context, supervisor: SupervisorChannel): () => void {
  return ctx.tools.register(defineTool({
    name: 'contact_supervisor',
    description: 'Ask the parent session for a decision or send a progress update. Use reason "need_decision" when blocked or when a decision is required to continue safely; "interview_request" for structured input; "progress_update" only for meaningful updates. The parent replies in a later turn. Do not use this for routine completion handoffs.',
    parameters: {
      reason: { type: 'string', enum: ['need_decision', 'interview_request', 'progress_update'], required: true, description: 'Why you are contacting the supervisor.' },
      message: { type: 'string', required: true, description: 'Concise message for the parent.' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { id: { type: 'string', required: true }, delivered: { type: 'boolean', required: true } } },
      render: (_args, value) => [{ type: 'text', text: value.delivered ? `supervisor request ${value.id} delivered` : `supervisor request ${value.id} queued` }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('contact_supervisor requires a calling agent')
      const result = await supervisor.ask(agent.session.id, args.reason, args.message)
      if (result.error) throw new Error(result.error)
      return { id: result.id, delivered: true }
    },
  }))
}

/** 父会话查看/回复子代理请求。 */
export function registerSupervisorReplyTool(ctx: Context, supervisor: SupervisorChannel, parentSessionId: () => string): () => void {
  return ctx.tools.register(defineTool({
    name: 'subagents_supervisor',
    description: 'Manage supervisor requests from child subagents: reply to a pending request or list pending ones. Requests appear when a child calls contact_supervisor (usually reason "need_decision").',
    parameters: {
      action: { type: 'string', enum: ['reply', 'pending'], required: true, description: 'reply answers one request; pending lists open requests.' },
      replyTo: { type: 'string', description: 'Request id to reply to (required for reply).' },
      message: { type: 'string', description: 'Reply text (required for reply).' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args) {
      const sessionId = parentSessionId()
      if (args.action === 'pending') {
        const pending = supervisor.pending(sessionId)
        if (pending.length === 0) return 'No pending supervisor requests.'
        return pending.map((request) => `- ${request.id} ${request.childAgent} (${request.reason}): ${request.message.slice(0, 300)}`).join('\n')
      }
      if (!args.replyTo || !args.message) throw new Error('reply requires replyTo and message')
      const result = await supervisor.reply(sessionId, args.replyTo, args.message)
      if (!result.ok) throw new Error(result.error ?? 'reply failed')
      return `Reply delivered to request ${args.replyTo}.`
    },
  }))
}

/** 等待活跃运行变化（非阻塞式订阅）。 */
export function registerWaitTool(ctx: Context, sessionState: SessionState, parentSessionId: () => string): () => void {
  return ctx.tools.register(defineTool({
    name: 'subagents_wait',
    description: 'Wait for active subagents work from this session to change. Resolves immediately with current status when nothing is running or when nonBlocking is true.',
    parameters: {
      id: { type: 'string', description: 'Optional run id to wait on.' },
      nonBlocking: { type: 'boolean', description: 'Return immediately with the current snapshot instead of blocking.' },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      const store = sessionState.stores.get(parentSessionId())
      const active = store?.activeRuns() ?? []
      if (args.nonBlocking || active.length === 0) {
        return active.length === 0 ? 'No active subagents runs.' : `Active runs: ${active.map((run) => `${run.id} (${run.agent})`).join(', ')}`
      }
      // 阻塞等待首个活跃运行结束（有界 10 分钟，父调用中止时立即返回）
      const deadline = Date.now() + WAIT_MAX_MS
      for (;;) {
        const current = store?.activeRuns() ?? []
        if (current.length === 0) return 'All subagents runs settled.'
        if (exec.signal.aborted) return `Wait aborted: still active: ${current.map((run) => `${run.id} (${run.agent})`).join(', ')}`
        if (Date.now() >= deadline) return `Still active: ${current.map((run) => `${run.id} (${run.agent})`).join(', ')}`
        await sleep(WAIT_POLL_MS, exec.signal)
      }
    },
  }))
}
