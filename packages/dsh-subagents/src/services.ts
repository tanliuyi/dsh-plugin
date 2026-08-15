/**
 * 项目级服务容器：每个项目根一份 MissionStore + ScheduleManager（懒创建）。
 * 调度到点后回找创建者会话作为 parent agent 启动后台 workflow。
 */

import type { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentsConfig } from './types.ts'
import { resolveProjectRoot } from './util.ts'
import { MissionStore } from './missions/store.ts'
import { ScheduleManager, type ScheduleDefinition } from './schedules/manager.ts'
import type { SubagentsDeps, SessionState } from './runs/execution.ts'

export interface ProjectServicesOptions {
  config: SubagentsConfig
  home: string
  getDeps: () => SubagentsDeps
  getSessionState: () => SessionState
}

export interface ProjectServicesBundle {
  missions: MissionStore
  schedules: ScheduleManager
}

export class ProjectServices {
  private readonly map = new Map<string, ProjectServicesBundle>()

  constructor(private readonly options: ProjectServicesOptions) {}

  for(projectRoot: string): ProjectServicesBundle {
    let bundle = this.map.get(projectRoot)
    if (!bundle) {
      const missions = new MissionStore(this.options.config, projectRoot, this.options.home)
      const schedules = new ScheduleManager({
        config: this.options.config,
        projectRoot,
        onFire: (definition, runId) => this.fire(definition, runId),
      })
      bundle = { missions, schedules }
      this.map.set(projectRoot, bundle)
      // 调度器定时器挂到插件 fiber：卸载时自动 stop（dispose 兜底同样幂等）
      const ctx = this.options.getDeps().ctx
      ctx.effect(() => {
        void schedules.start().catch((error) => {
          ctx.logger.warn(`[dsh-subagents] schedule manager start failed for ${projectRoot}: ${String(error)}`)
        })
        return () => schedules.stop()
      })
    }
    return bundle
  }

  /** 回收全部项目级服务（调度定时器等）；插件卸载时由 apply 的清理函数调用。 */
  dispose(): void {
    for (const bundle of this.map.values()) {
      bundle.schedules.stop()
    }
    this.map.clear()
  }

  private async fire(definition: ScheduleDefinition, runId: string): Promise<void> {
    const deps = this.options.getDeps()
    const state = this.options.getSessionState()
    const agents = deps.ctx.get('agents')
    const parent = (definition.creatorSessionId ? agents?.get(definition.creatorSessionId as SessionId) : undefined) ?? agents?.roots()[0]
    if (!parent) {
      deps.ctx.logger.info(`[dsh-subagents] schedule ${definition.id} fired but no live parent agent is available to start its workflow`)
      return
    }
    const cwd = definition.cwd ?? parent.session.header.cwd ?? process.cwd()
    const { executeSubagents } = await import('./runs/execution.ts')
    const services = deps.services.for(resolveProjectRoot(cwd))
    try {
      await executeSubagents(deps, state, {
        parent,
        signal: new AbortController().signal,
        cwd,
      }, {
        workflowScript: definition.workflowScript,
        async: true,
        mission: false,
      })
      await services.schedules.markRunTerminal(definition.id, runId, 'completed')
      deps.ctx.logger.info(`[dsh-subagents] schedule ${definition.id} fired (run ${runId})`)
    } catch (error) {
      await services.schedules.markRunTerminal(definition.id, runId, 'failed')
      deps.ctx.logger.warn(`[dsh-subagents] schedule ${definition.id} fire failed (run ${runId}): ${String(error)}`)
    }
  }
}
