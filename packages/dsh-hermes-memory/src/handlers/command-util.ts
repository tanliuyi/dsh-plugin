/**
 * 命令工具 — 从命令调用上下文解析 cwd。
 */

/**
 * 从命令发起 agent 解析工作目录。
 * @param agent - 命令发起 agent
 */
export function cwdFromInvocation(agent: { session?: { header?: { cwd?: string } } }): string | undefined {
  return agent.session?.header?.cwd
}
