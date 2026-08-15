/**
 * 会话工具 — 从 dsh Session 提取对话文本（上游 sessionManager.getBranch() 的替代）。
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { getMessageText } from '../types.ts'

/**
 * 把会话事件日志折叠为 "[USER]/[ASSISTANT]: text" 行。
 * @param session - dsh 会话
 * @param recentMessages - 只取最近 N 条（0 = 全部）
 */
export function collectSessionParts(session: Session, recentMessages = 0): string[] {
  const parts: string[] = []

  for (const event of session.events) {
    if (event.type !== 'user/message' && event.type !== 'assistant/message') continue
    const text = getMessageText(event.data)
    if (!text) continue
    const prefix = event.type === 'user/message' ? '[USER]' : '[ASSISTANT]'
    parts.push(`${prefix}: ${text}`)
  }

  if (Number.isFinite(recentMessages) && recentMessages > 0) {
    return parts.slice(-recentMessages)
  }
  return parts
}

/** 判断 user/message 事件是否来自真人（非注入上下文）。 */
export function isDirectUserMessage(event: { type: string; data?: { source?: { kind?: string } } }): boolean {
  return event.type === 'user/message' && event.data?.source?.kind === 'user'
}
