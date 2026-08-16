/**
 * Completion mutation guard（对齐上游 pi-subagents src/runs/shared/completion-guard.ts）。
 *
 * 语义：实现类任务（expectedMutation）若子代理从未调用写工具（edit/write/bash
 * 变更命令），判定 triggered——对齐上游「Subagent completed without making edits
 * for an implementation task.」。上游从子代理消息流检测 mutation 工具调用；dsh 无
 * 消息流，由 spawn.ts 用全局 tool/call 事件（按 child 会话）观察写工具调用，替代
 * hasMutationToolCall 的 attemptedMutation 检测。
 */

import { expectsImplementationMutation } from './task-intent.ts'

/** 上游 READ_ONLY_BUILTIN_TOOLS：这些工具不构成 mutation 能力。 */
const READ_ONLY_BUILTIN_TOOLS = new Set([
  'read',
  'grep',
  'find',
  'ls',
  'web_search',
  'fetch_content',
  'get_search_content',
  'intercom',
  'contact_supervisor',
])

export interface CompletionMutationGuardInput {
  agent: string
  task: string
  /** 部署过滤后的有效工具集（undefined → 视为具备 mutation 能力，对齐上游）。 */
  tools?: string[]
  /** 已观察到的写工具调用名（dsh 用全局 tool/call 事件收集，替代上游消息流检测）。 */
  observedMutationTools: string[]
}

export interface CompletionMutationGuardResult {
  expectedMutation: boolean
  attemptedMutation: boolean
  triggered: boolean
}

/** 上游 hasMutationToolCapability：mcp 工具存在或 tools 非全只读即具备。dsh 无 mcp。 */
export function hasMutationToolCapability(tools: string[] | undefined): boolean {
  if (tools === undefined) return true
  return !tools.every((tool) => READ_ONLY_BUILTIN_TOOLS.has(tool))
}

/**
 * 写工具判定（对齐上游 isMutatingTool 的 dsh 子集）：edit/write 恒定变更；
 * bash 视命令是否为变更命令（上游 isMutatingBashCommand 语义的近似：git
 * apply/commit/push、mv/cp/rm、sed -i、tee >、> 重定向等）。dsh tool/call
 * 事件只携带工具名，无参数——无法精确区分 bash 只读/变更，按上游
 * isMutatingBashCommand 的保守近似处理。
 */
export function isMutatingToolName(toolName: string): boolean {
  if (!toolName) return false
  if (toolName === 'edit' || toolName === 'write') return true
  if (toolName === 'cursor') return true
  if (toolName === 'bash') return true
  return false
}

/** 全局 session/event 中可携带工具数据的事件形状（仅取本 helper 所需字段）。 */
export interface ToolMutationEventLike {
  type?: string
  data?: { name?: string; isError?: unknown }
}

/**
 * 从全局 session/event 中提取「变更命名工具名」，非变更事件返回 null。
 * 支持两种执行模式（completion mutation guard 的 attemptedMutation 检测）：
 *
 * - 普通模式 tool/call：直接取 data.name，命中 isMutatingToolName 即返回。
 * - code 模式 tool/code-dispatch：外层是 run_code（本身非变更工具，不会计入），
 *   真正变更发生在嵌套分派；仅当 data.name 命中变更且 isError 为假值（成功）时
 *   计数；失败（isError 为真）不计数（对齐「可实现但实际失败不视为编辑」语义）。
 *
 * 此 helper 纯函数化 payload 适配，便于单元测试镜像真实事件载荷。
 */
export function mutationToolNameFromEvent(event: ToolMutationEventLike): string | null {
  if (!event || typeof event.type !== 'string') return null
  const name = event.data?.name
  if (!name || typeof name !== 'string') return null
  if (event.type === 'tool/code-dispatch') {
    // 嵌套调用失败不计入 mutation（只有成功执行的写工具才算「真的编辑过」）
    if (event.data?.isError) return null
  } else if (event.type !== 'tool/call') {
    return null
  }
  return isMutatingToolName(name) ? name : null
}

/** 评估 completion mutation guard。 */
export function evaluateCompletionMutationGuard(input: CompletionMutationGuardInput): CompletionMutationGuardResult {
  const expectedMutation = hasMutationToolCapability(input.tools)
    ? expectsImplementationMutation(input.agent, input.task)
    : false
  const attemptedMutation = input.observedMutationTools.length > 0
  return {
    expectedMutation,
    attemptedMutation,
    triggered: expectedMutation && !attemptedMutation,
  }
}

/** 上游 completionGuard 触发时的错误消息。 */
export const COMPLETION_GUARD_ERROR = 'Subagent completed without making edits for an implementation task.'
