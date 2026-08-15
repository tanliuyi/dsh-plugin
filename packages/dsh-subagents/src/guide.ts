/**
 * guide 动作：读取包内 docs/<topic>.md（缺省 README 摘要）。
 */

import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const TOPICS = ['overview', 'workflows', 'agents', 'missions', 'observability', 'tool-reference', 'configuration', 'models', 'watchdog', 'extension-api']

export function guideTopics(): string[] {
  return TOPICS
}

function docsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs')
}

const OVERVIEW = `dsh-subagents — pi-subagents 的 dsh 移植。

- 委派：subagents({ agent, task }) 或 subagents({ workflowScript })
- 管理：subagents({ action: "list" | "get" | "create" | "guide" | "doctor" | "status" })
- 内置 agents：scout / researcher / worker / reviewer / oracle / delegate
- 后台：subagents({ agent, task, async: true })；状态 subagents({ action: "status" })
- missions / schedules / watchdog：见 guide topic

Topics: ${TOPICS.join(', ')}
使用 subagents({ action: "guide", topic: "..." }) 查看。`

export async function guide(topic?: string): Promise<string> {
  if (!topic || topic === 'overview') return OVERVIEW
  if (!TOPICS.includes(topic)) return `Unknown topic "${topic}". Valid topics: ${TOPICS.join(', ')}`
  try {
    const content = await readFile(path.join(docsDir(), `${topic}.md`), 'utf8')
    return `# ${topic}\n\n${content.slice(0, 12_000)}`
  } catch {
    return `docs/${topic}.md is not shipped in this install; see the package README.`
  }
}
