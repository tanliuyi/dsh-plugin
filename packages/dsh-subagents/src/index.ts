/**
 * dsh-subagents：pi-subagents（https://github.com/nicobailon/pi-subagents，MIT）
 * 的 dsh 移植。注册 `subagents` 工具（委派/工作流/管理动作）、supervisor
 * 通道、missions、schedules、watchdog、goal 驱动、slash 命令与技能。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Config as ConfigSchema, normalizeConfig } from './config.ts'
import type { SubagentsConfig } from './types.ts'
import { AgentRegistry } from './agents/registry.ts'
import { SupervisorChannel } from './intercom/supervisor.ts'
import { ProjectServices } from './services.ts'
import { SessionState, type SubagentsDeps } from './runs/execution.ts'
import { registerSubagentsTool } from './tool.ts'
import { registerContactSupervisorTool, registerSupervisorReplyTool, registerWaitTool } from './tools-extra.ts'
import { registerGoalDriver } from './missions/goal-driver.ts'
import { registerWatchdog } from './watchdog/main.ts'
import { registerSlashCommands } from './slash/commands.ts'
import { registerSubagentsSkill } from './skill.ts'
import { resolveProjectRoot } from './util.ts'

export const name = 'subagents'

export const inject = ['tools', 'subagents', 'agents', 'sessions']

/** 插件配置（Schema 校验后的用户输入）。 */
export type Config = import('./config.ts').Config

/** 插件配置 Schema。 */
export const Config = ConfigSchema

/**
 * 插件入口。
 * @param ctx - 插件上下文（tools/subagents/agents/sessions 已就绪）
 * @param config - 插件配置
 */
export function apply(ctx: Context, config: Config) {
  const normalized: SubagentsConfig = normalizeConfig(config)
  const home = process.env.HOME ?? ''
  const registry = new AgentRegistry(normalized, home)
  const sessionState = new SessionState((message) => ctx.logger.warn(message))

  const supervisor = new SupervisorChannel({
    ctx,
    parentOf: (childSessionId) => {
      for (const store of sessionState.stores.values()) {
        const child = store.childByRunId(childSessionId)
        if (child) return { parentSessionId: store.sessionId, agent: child.agent }
      }
      return undefined
    },
  })

  let deps: SubagentsDeps = undefined as never
  const services = new ProjectServices({
    config: normalized,
    home,
    getDeps: () => deps,
    getSessionState: () => sessionState,
  })
  deps = { ctx, config: normalized, registry, supervisor, services, home }

  const parentSessionId = (): SessionId => ctx.get('agents')?.currentInitiator()?.session.id ?? '' as SessionId

  // 工具注册（全部为 effect，插件卸载时自动回收）
  const disposers: Array<() => void> = []
  disposers.push(registerSubagentsTool(ctx, deps, sessionState))
  disposers.push(registerContactSupervisorTool(ctx, supervisor))
  disposers.push(registerSupervisorReplyTool(ctx, supervisor, parentSessionId))
  disposers.push(registerWaitTool(ctx, sessionState, parentSessionId))

  // 回合跟踪：后台完成通知据此判断能否回合内注入
  disposers.push(ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start') sessionState.activeTurns.set(session.id, true)
    else if (event.type === 'turn/end') sessionState.activeTurns.delete(session.id)
  }))

  // goal 驱动：父会话回合结束 → needs-attention 通知
  disposers.push(registerGoalDriver({
    ctx,
    storeFor: (sessionId) => {
      const cwd = ctx.get('sessions')?.get(sessionId as SessionId)?.header.cwd ?? process.cwd()
      return services.for(resolveProjectRoot(cwd)).missions
    },
    isChild: (sessionId) => {
      const header = ctx.get('sessions')?.get(sessionId as SessionId)?.header
      return header?.origin === 'subagent' || header?.parentSession !== undefined
    },
  }))

  // watchdog：可选对抗性评审
  disposers.push(registerWatchdog({ ctx, config: normalized, home }))

  // slash 命令（可选服务）
  disposers.push(registerSlashCommands(ctx, deps, sessionState))

  // 内置技能（可选服务）
  disposers.push(registerSubagentsSkill(ctx))

  // 清理：工具/命令/技能 disposer + 项目级服务（调度定时器等）随 fiber 回收
  return () => {
    for (const dispose of disposers) dispose()
    services.dispose()
  }
}
