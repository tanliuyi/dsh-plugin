/**
 * 通知投递：运行中的 agent 用 `inject`（回合内上下文注入，最近的下一个
 * pre-step 边界即可见），空闲的 agent 用 `followup`（唤醒并开新回合）。
 * 对应 pi-subagents 的 needs-attention 可见通知语义。
 */

import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export type NoticeMode = 'auto' | 'inject' | 'followup'

export function deliverNotice(agent: Agent, text: string, mode: NoticeMode = 'auto'): void {
  const message = createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'plugin', plugin: 'dsh-subagents' },
  })
  const useInject = mode === 'inject' || (mode === 'auto' && agent.status === 'running')
  if (useInject) {
    agent.inject(message)
  } else {
    agent.followup(message)
  }
}
