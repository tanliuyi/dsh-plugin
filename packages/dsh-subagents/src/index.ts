/**
 * dsh-subagents：pi-subagents（https://github.com/nicobailon/pi-subagents，MIT）
 * 的 dsh 移植。注册 `subagents` 工具（委派/工作流/管理动作）、supervisor
 * 通道、missions、schedules、watchdog、goal 驱动、slash 命令与技能。
 */

import type { Context } from '@deepseek-ai/cordis'
// 类型面引入即激活 loader/entry-init 等 Events 声明（运行时无需该包）。
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { Config as ConfigSchema, normalizeConfig } from './config.ts'
import type { SubagentsConfig } from './types.ts'
import { buildEffectiveConfig, loadWebSettingsSync } from './web-settings.ts'
import { registerWebSettingsRoute } from './web-route.ts'
import { registerClientBundle } from './web-client.ts'
import { AgentRegistry } from './agents/registry.ts'
import { SupervisorChannel } from './intercom/supervisor.ts'
import { ProjectServices } from './services.ts'
import { SessionState, type SubagentsDeps } from './runs/execution.ts'
import { registerSubagentsTool } from './tool.ts'
import { registerContactSupervisorTool, registerSupervisorReplyTool, registerWaitTool } from './tools-extra.ts'
import { registerReportTool } from './report.ts'
import { registerGoalDriver } from './missions/goal-driver.ts'
import { registerWatchdog } from './watchdog/main.ts'
import { registerSlashCommands } from './slash/commands.ts'
import { registerSubagentsSkill } from './skill.ts'
import { registerMinimalPresetIsolation, SUBAGENTS_GLOBAL_TOOLS } from './presets.ts'
import { resolveProjectRoot } from './util.ts'

export const name = 'subagents'

export const inject = ['tools', 'subagents', 'agents', 'sessions']

// 规范的全局模型面工具名数组（minimal 预设隔离据此驳回）。
export { MINIMAL_PRESET_ID, registerMinimalPresetIsolation, SUBAGENTS_GLOBAL_TOOLS } from './presets.ts'

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
  const home = process.env.HOME ?? ''

  // Web 设置页覆盖（~/.dsh/subagents/web-settings.json）合并到归一化配置之上；
  // baseline 是纯 cordis 配置快照，供设置页计算差异与复位。
  const webOverrides = loadWebSettingsSync(home)
  const normalized: SubagentsConfig = buildEffectiveConfig(config, webOverrides)
  const baseline: SubagentsConfig = normalizeConfig(config)
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
  // Web 设置页路由：webServer 可用时注册（TUI/headless 无 webServer，永不注册）。
  // webServer 不能作为必选 inject（非 web profile 不存在），且 cordis 的
  // ctx.webServer 属性访问要求显式注入，因此经 ctx.get 取得后传入路由函数。
  // exact 路由优先于 api-proxy 的 /api 前缀，自带回环信任校验。
  // webServer 在 web profile 中与插件并行激活。事件驱动：
  // 1) apply 时立即检查（webserver 可能已就绪）；
  // 2) 监听 cordis 核心服务事件 internal/service（服务提供/移除时由服务注册表
  //    发射，payload 第二参为实例或 undefined），服务出现即注册。
  // 注册成功即不再重复；插件卸载时监听随 fiber 自动回收。
  let registered = false
  let routeDispose: (() => void) | undefined
  // 注销路由并复位状态：服务移除时显式调用路由 disposer（route 表是实例级，
  // 正常路径旧实例随 fiber 卸载销毁、路由随之消失，但显式注销不依赖该隐含
  // 事实，也覆盖非标准移除路径），重提供时重新注册，不累积重复路由。
  const unregisterWebSurface = (): void => {
    registered = false
    if (routeDispose) {
      try {
        routeDispose()
      } catch (error) {
        ctx.logger.warn('dsh-subagents: failed to unregister web settings route', error)
      }
      routeDispose = undefined
    }
  }
  const registerWebSurface = (): void => {
    const server = ctx.get('webServer')
    if (!server) {
      // 服务暂不可用：注销（如有）并复位标志，等 internal/service 事件再触发
      unregisterWebSurface()
      return
    }
    if (registered) return
    registered = true
    try {
      routeDispose = registerWebSettingsRoute(ctx, server, { config: normalized, baseline, home })
    } catch (error) {
      // 注册失败：复位标志，允许服务重提供/再次事件时重试
      registered = false
      ctx.logger.warn('dsh-subagents: failed to register web settings route', error)
    }
    try {
      const outcome = registerClientBundle(ctx)
      if (outcome !== 'registered' && outcome !== 'no-registry') {
        ctx.logger.warn('dsh-subagents: client bundle not registered (' + outcome + '); the settings page will be unavailable')
      }
    } catch (error) {
      ctx.logger.warn('dsh-subagents: failed to self-register client bundle', error)
    }
  }
  // 事件驱动：internal/service 在提供方上下文发射并向上传播，本插件是
  // 兄弟节点，须在根上下文监听。payload 第二参为服务实例：存在 → 注册，
  // undefined → 服务已移除（显式注销路由，webServer 重提供/热重载后重新注册）。
  // apply 时的立即检查覆盖「服务已就绪」顺序。时序保证：
  // - apply 同步执行、服务提供事件的发射也同步（cordis notify()），两者不可
  //   能交错，不存在「listener 挂载前事件已发射」的窗口；
  // - 服务已提供时 ctx.get('webServer') 必返回实例（立即检查必然命中）；
  // - 插件自身热重载 → 新 apply 重新挂 listener + 立即检查，状态全新；
  // - webServer 热重载 → 移除事件显式注销，重提供事件重新注册，不累积。
  disposers.push(ctx.root.on('internal/service', (name, value) => {
    if (name !== 'webServer') return
    if (value !== undefined) registerWebSurface()
    else unregisterWebSurface()
  }))
  registerWebSurface()
  disposers.push(registerSubagentsTool(ctx, deps, sessionState))
  disposers.push(registerContactSupervisorTool(ctx, supervisor))
  disposers.push(registerSupervisorReplyTool(ctx, supervisor, parentSessionId))
  disposers.push(registerWaitTool(ctx, sessionState, parentSessionId))

  // 最小预设（minimal）隔离：minimal agent 只应看到其自身两个本地工具，
  // 移除本插件全局注册的模型面工具（restrict 归属 agent.ctx，随 agent 卸载自动回收）。
  disposers.push(registerMinimalPresetIsolation(ctx, SUBAGENTS_GLOBAL_TOOLS))

  // 回合跟踪：后台完成通知据此判断能否回合内注入。先挂 listener 再 hydrate：
  // Cordis 事件派发同步，且 session/event 的 observer 在本地 log push 之后回调
  //（「先 append 后 notify」），故 hydrate 读取的 session.events 快照必然已含
  // listener 刚增量处理的事件；attach-then-hydrate 使挂载窗内发生的事件既被
  // 增量记录又被 hydrate 幂等折叠（同一终态），不存在「事件发生于 hydrate 之后、
  // listener 挂载之前」的丢失窗口。插件热重载/重连时新 apply 据此重建 activeTurns，
  // 避免已开回合被误判为停靠（queued 报告错选 wakeup）。
  disposers.push(ctx.on('session/event', (session, event) => {
    sessionState.applyTurnEvent(session.id, event.type)
  }))
  sessionState.hydrate(ctx.sessions.list())

  // 子代理反向回报通道：为 continuable 子代理安装 `report` 工具；投递策略按
  // 直接父会话回合状态动态选择（回合开 → quiet 回合内注入，否则 wakeup），
  // 对齐 known-issues 第 4 条的修复建议。hydrate 在注册前已完成，report 解析时
  // 必然读到重建后的回合状态。
  disposers.push(registerReportTool(ctx, sessionState))

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

  // watchdog：可选对抗性评审（对齐上游 register-main/register-child 语义）
  const watchdog = registerWatchdog({
    ctx,
    config: normalized,
    home,
    childAgentName: (sessionId) => {
      for (const store of sessionState.stores.values()) {
        const child = store.childByRunId(sessionId)
        if (child) return child.agent
      }
      return undefined
    },
  })
  deps.watchdog = watchdog
  disposers.push(() => watchdog.dispose())

  // slash 命令（可选服务）
  disposers.push(registerSlashCommands(ctx, deps, sessionState))

  // 内置技能（可选服务）
  disposers.push(registerSubagentsSkill(ctx))

  // 清理：路由（routeDispose 独立管理，服务移除时已显式注销）、工具/命令/
  // 技能 disposer + 项目级服务（调度定时器等）随 fiber 回收
  return () => {
    unregisterWebSurface()
    for (const dispose of disposers) dispose()
    services.dispose()
  }
}
