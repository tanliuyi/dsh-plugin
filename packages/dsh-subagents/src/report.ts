/**
 * 子代理反向回报通道：continuable 子代理的 `report` 工具与配套 prompt 段落。
 *
 * 本模块是 dsh 官方 @deepseek-ai/dsh-tool-subagent-report 的插件级替代：
 * schema、guidance、output 与 source 行为对齐上游（子作用域注册、对父不可见、
 * 一次完整回答 + 中途进展回报、不结束回合、`reportFrom` 投递），唯一改动是
 * 投递策略从「固定 config」改为「按父会话回合状态动态选择」：
 * - 直接父会话的回合是开的（SessionState turn/start → turn/end 之间）→ quiet
 *   （回合内 inject，不另起唤醒回合，避免排队消息）；否则 → wakeup。
 * 该策略对齐 docs/development/known-issues.md 第 4 条的修复建议
 * （以「回合是否已打开」而非 agent.status 判定注入时机）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentReportDelivery } from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionState } from './runs/execution.ts'

/** 每回合工具段落之后的 guidance 顺序（对齐上游 REPORT_SECTION_ORDER）。 */
export const REPORT_SECTION_ORDER = 117

/** `report` 工具的 guidance 文本（对齐上游原文）。 */
export const REPORT_SECTION_TEXT =
  'Deliver your result with the report tool before you finish: call it once with a self-contained answer. The agent that started you shares your workspace but does not automatically receive your transcript, tool output, or reasoning, so a closing remark such as \"done\" leaves it nothing it can use. Report earlier as well whenever a partial finding changes what that agent should do next; reporting never ends your turn.'

/** 判断该子代理（与父无关）应选何种投递策略的解析器。 */
export type ReportDeliveryResolver = (child: Agent) => SubagentReportDelivery

/**
 * 解析一次报告应使用的投递策略：直接父会话正在活跃回合 → quiet，否则 wakeup。
 * 直接父会话 id 由 child.session.header.parentSession 直接解析，对齐 DSH 核心
 * reportFrom 的权威来源（dsh-subagent 的 resolveReportParent 同样直接读该字段）。
 * @param sessionState - 插件级回合跟踪（turn/start → turn/end）。
 * @param child - 上报子代理（其 session.header.parentSession 是直接父会话）。
 */
export function resolveParentDelivery(sessionState: SessionState, child: Agent): SubagentReportDelivery {
  const parentSessionId = child?.session?.header?.parentSession as SessionId | undefined
  if (!parentSessionId) return 'wakeup'
  return sessionState.isTurnOpen(parentSessionId) ? 'quiet' : 'wakeup'
}

/**
 * 向一个 continuable 子作用域安装 `report` 工具与其 guidance。
 * 两处注册都归属该子作用域，对父与会话不可见。
 * @param childCtx - 接收工具与 guidance 的子作用域上下文。
 * @param ctx - 用于投递的服务上下文。
 * @param resolveDelivery - 每次调用动态解析投递策略（缺省按父回合状态）。
 * @returns 撤回两者的 disposer（任一失败都上报清理失败）。
 */
export function installReportTool(childCtx: Context, ctx: Context, resolveDelivery: ReportDeliveryResolver): () => void {
  const disposeSection = childCtx.systemPrompt.section({
    name: 'tool:report',
    order: REPORT_SECTION_ORDER,
    text: REPORT_SECTION_TEXT,
  })
  let disposeTool
  try {
    disposeTool = childCtx.tools.register(defineTool({
      name: 'report',
      description: 'Report selected content to the agent that started you. Call this once before you finish, with a self-contained final result, and earlier for progress or findings that change what that agent does next. That agent shares your workspace but does not automatically receive your transcript, tool output, or reasoning, so finishing your work is not itself a result. Reporting does not end your turn or finish your work, and only your direct parent receives it. A failed call may still have arrived, so do not blindly repeat it.',
      parameters: { output: {
        type: 'string',
        required: true,
        description: 'Actionable content for your parent; summarize conclusions and reference relevant shared paths.',
      } },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { messageId: { type: 'string', required: true } },
        },
        render: (_args, value) => [{
          type: 'text',
          text: `report accepted by the agent that started you as message ${value.messageId}`,
        }],
      },
      async execute(args, exec) {
        const agent = exec.agent
        if (!agent) throw new Error('report requires a calling agent')
        const content: ContentBlock[] = [{ type: 'text', text: args.output }]
        const delivery = resolveDelivery(agent)
        return { messageId: await ctx.subagents.reportFrom(agent, content, { delivery, signal: exec.signal }) }
      },
    }))
  } catch (error) {
    try {
      disposeSection()
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'failed to register the report tool and roll back its prompt guidance')
    }
    throw error
  }
  return () => {
    const failures: unknown[] = []
    for (const dispose of [disposeTool, disposeSection]) {
      try {
        dispose()
      } catch (error) {
        failures.push(error)
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, 'failed to revoke report tool and prompt registrations')
  }
}

/**
 * 注册本插件的 continuable-child 回报贡献：为每个新建/冷恢复的 continuable
 * 子代理安装 `report` 工具与 guidance，投递策略按直接父回合状态动态选择。
 * @param ctx - 携带 subagents/tools/systemPrompt（报告投递上下文）的插件上下文。
 * @param sessionState - 插件级回合跟踪。
 * @returns 卸载时的注册 disposer。
 */
export function registerReportTool(ctx: Context, sessionState: SessionState): () => void {
  return ctx.subagents.registerContinuableSetup((childCtx) =>
    installReportTool(childCtx, ctx, (child) => resolveParentDelivery(sessionState, child)),
  )
}