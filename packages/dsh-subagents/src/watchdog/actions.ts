/**
 * Watchdog 管理动作：watchdog.configure / recommend-model / status / check。
 * 持久化配置写入用户级 settings 目录下的 watchdog.json（与 dsh 配置分离，
 * 便于会话级临时覆盖）。
 */

import type { SubagentsParams } from '../types.ts'
import type { SubagentsDeps, ExecContext } from '../runs/execution.ts'
import { readJsonFile, writeJsonAtomic } from '../util.ts'

/** watchdog 用户级配置文件（watchdog.json）的形状。 */
export interface WatchdogFile {
  enabled?: boolean
  main?: { model?: string; thinking?: string | false }
  scope?: { enabled?: boolean }
  cadence?: { everyNTools?: number }
  autoFollow?: { blockers?: boolean; maxAttempts?: number; stalemateRepeats?: number }
}

/** 用户级 watchdog 配置文件路径。 */
export function watchdogFile(home: string): string {
  return `${home}/.dsh/subagents/watchdog.json`
}

/** 读取 watchdog 配置文件（缺失返回空对象）。 */
export async function loadWatchdogFile(home: string): Promise<WatchdogFile> {
  return (await readJsonFile<WatchdogFile>(watchdogFile(home))) ?? {}
}

/** 原子写入 watchdog 配置文件。 */
export async function saveWatchdogFile(home: string, file: WatchdogFile): Promise<void> {
  await writeJsonAtomic(watchdogFile(home), file)
}

export async function runWatchdogAction(
  deps: SubagentsDeps,
  exec: ExecContext,
  params: SubagentsParams,
  action: string,
  _projectRoot: string,
): Promise<{ text: string; details: import('../types.ts').Details }> {
  switch (action) {
    case 'watchdog.recommend-model': {
      // 推荐策略（对齐 pi）：Opus 4.8 或 GPT 5.5，与主会话互补
      return {
        text: 'Recommended strong watchdog pairing: `anthropic/claude-opus-4-8:high` (or `openai-codex/gpt-5.5:high` when the main session uses Anthropic). Configure with `subagents({ action: "watchdog.configure", model: "recommended", scope: "session" })` or set `watchdog.main.model` in plugin config.',
        details: { kind: 'watchdog', results: [] },
      }
    }
    case 'watchdog.configure': {
      const file = await loadWatchdogFile(deps.home)
      const scope = params.scope ?? 'session'
      if (params.model === 'recommended') {
        file.main = { model: 'anthropic/claude-opus-4-8', thinking: 'high' }
      } else if (params.model === 'inherit' || params.model === undefined) {
        delete file.main
      } else if (typeof params.model === 'string') {
        file.main = { ...file.main, model: params.model, thinking: params.thinking !== undefined ? params.thinking : file.main?.thinking }
      } else if (params.thinking !== undefined) {
        file.main = { ...file.main, thinking: params.thinking }
      }
      if (scope === 'session') {
        // 会话级：写入文件但标注 session；下次会话由用户决定是否保留
        await saveWatchdogFile(deps.home, file)
        return { text: `Configured watchdog for this session (${JSON.stringify(file.main ?? {})})`, details: { kind: 'watchdog', results: [] } }
      }
      await saveWatchdogFile(deps.home, file)
      return { text: `Saved watchdog configuration (${scope}): ${JSON.stringify(file.main ?? {})}`, details: { kind: 'watchdog', results: [] } }
    }
    case 'watchdog.status':
    case 'watchdog.check': {
      const config = deps.config.watchdog
      const file = await loadWatchdogFile(deps.home)
      const effective = { ...config, ...(file.main ? { main: file.main } : {}), enabled: file.enabled ?? config.enabled }
      const lines = [
        `Watchdog enabled: ${effective.enabled}`,
        `Main model: ${effective.main.model ?? '(inherit session model)'}`,
        `Thinking: ${effective.main.thinking ?? '(inherit)'}`,
        `Scope monitoring: ${effective.scope.enabled}`,
        action === 'watchdog.check' ? 'Check: watchdog edits are reviewed at the safe agent_end boundary when repo state changed; config is valid.' : '',
      ].filter(Boolean)
      return { text: lines.join('\n'), details: { kind: 'watchdog', results: [] } }
    }
    default:
      return { text: `unknown watchdog action: ${action}`, details: { kind: 'error', results: [] } }
  }
}
