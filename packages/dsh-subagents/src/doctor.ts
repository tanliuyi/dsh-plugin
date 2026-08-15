/**
 * doctor：检查插件配置、provider、agent 目录、mission 存储、调度器、
 * intercom 通道与预算状态。
 */

import type { SubagentsDeps, ExecContext, SessionState } from './runs/execution.ts'
import { builtinAgentsDir, userAgentsDir } from './agents/registry.ts'
import { resolveProjectRoot } from './util.ts'

export async function doctor(deps: SubagentsDeps, exec: ExecContext, state: SessionState): Promise<string> {
  const lines: string[] = []
  const ctx = deps.ctx

  lines.push('dsh-subagents doctor:')
  lines.push('')

  // providers
  const providers = ctx.get('subagents')
  if (providers) {
    const names = providers.list()
    lines.push(`subagents providers: ${names.length ? names.join(', ') : '(none registered)'}`)
    if (!names.includes('spawn')) lines.push('  ⚠ provider "spawn" is missing — child launches with fresh context will fail')
    if (!names.includes('fork')) lines.push('  ⚠ provider "fork" is missing — fork-context children will fail')
  } else {
    lines.push('⚠ ctx.subagents service unavailable')
  }

  // agent 目录
  const builtin = builtinAgentsDir()
  const user = userAgentsDir(deps.home)
  lines.push(`builtin agents dir: ${builtin}`)
  lines.push(`user agents dir: ${user}`)
  const agents = await deps.registry.list('both', resolveProjectRoot(exec.cwd))
  lines.push(`discovered agents: ${agents.length} (${agents.map((agent) => agent.name).slice(0, 10).join(', ')}${agents.length > 10 ? ', …' : ''})`)

  // 运行存储
  const store = state.stores.get(exec.parent.session.id)
  lines.push(`session runs: ${store ? store.list().length : 0}`)

  // 预算
  const budgets = state.budgetsFor(deps.config, exec.parent.session.id)
  const spawns = budgets.spawns.usage
  lines.push(`spawn budget: ${spawns.used} used${spawns.effectiveLimit !== undefined ? ` / ${spawns.effectiveLimit} (remaining ${spawns.remaining})` : ' (unlimited)'}`)
  const capacity = budgets.asyncCapacity.usage
  lines.push(`active async capacity: ${capacity.used}${capacity.effectiveLimit !== undefined ? ` / ${capacity.effectiveLimit}` : ' (unlimited)'}`)

  // missions
  const projectRoot = resolveProjectRoot(exec.cwd)
  try {
    const services = deps.services.for(projectRoot)
    const missions = await services.missions.list('project')
    lines.push(`missions: ${missions.length} in this project (store: ${services.missions.projectDir()})`)
  } catch (error) {
    lines.push(`missions: ⚠ store error: ${String(error)}`)
  }

  // schedules
  const schedules = await deps.services.for(projectRoot).schedules.list()
  lines.push(`schedules: ${schedules.length}${deps.config.scheduledRuns.enabled ? '' : ' (disabled by config)'}`)

  // intercom
  const stats = deps.supervisor.stats(exec.parent.session.id)
  lines.push(`supervisor channel: ${stats.pending} pending, ${stats.answered} answered`)
  const bridgeMode = deps.config.intercomBridge.mode
  lines.push(`intercom bridge mode: ${bridgeMode}`)

  // watchdog
  lines.push(`watchdog: ${deps.config.watchdog.enabled ? 'enabled' : 'disabled (opt-in)'}${deps.config.watchdog.main.model ? ` · model ${deps.config.watchdog.main.model}` : ''}`)

  // 可选服务
  lines.push(`jobs service: ${ctx.get('jobs') ? 'available' : 'missing (background runs disabled)'}`)
  lines.push(`commands service: ${ctx.get('commands') ? 'available' : 'missing (slash commands disabled)'}`)
  lines.push(`skills service: ${ctx.get('skills') ? 'available' : 'missing (skill registration skipped)'}`)

  return lines.join('\n')
}
