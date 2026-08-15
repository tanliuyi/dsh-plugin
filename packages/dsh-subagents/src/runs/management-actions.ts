/**
 * Agent 管理动作实现：list/get/create/update/delete/eject/disable/enable/reset
 * 与 refine 系列（refine / refine.show / refine.rollback）。
 */

import type { AgentConfig, SubagentsParams } from '../types.ts'
import { resolveProjectRoot } from '../util.ts'
import type { SubagentsDeps, ExecContext } from './execution.ts'
import { agentConfigFromManagementConfig, deleteAgent, ejectAgent, listScopeAgentFiles, readRefinement, refinementsDir, resetAgent, resolveManagementTarget, rollbackRefinement, setAgentDisabled, validateRefinementProposal, writeAgentFile, writeRefinement } from '../agents/management.ts'
import { readTextFile, writeJsonAtomic } from '../util.ts'
import { resolveLlmRoute, streamText } from '../llm.ts'

function fmtAgent(agent: AgentConfig): string {
  const lines = [
    `# ${agent.name}`,
    agent.description ? `Description: ${agent.description}` : '',
    agent.aliases?.length ? `Aliases: ${agent.aliases.join(', ')}` : '',
    agent.model ? `Model: ${agent.model}` : 'Model: (inherit parent)',
    agent.thinking !== undefined ? `Thinking: ${agent.thinking}` : '',
    agent.tools ? `Tools: ${agent.tools.join(', ')}` : 'Tools: (inherit all)',
    agent.defaultContext ? `Default context: ${agent.defaultContext}` : '',
    agent.timeoutMs ? `Timeout: ${agent.timeoutMs}ms` : '',
    agent.acceptance ? `Acceptance: ${JSON.stringify(agent.acceptance)}` : '',
    agent.scope !== 'builtin' && agent.file ? `File: ${agent.file}` : `Scope: ${agent.scope}`,
  ].filter(Boolean)
  if (agent.systemPrompt) lines.push('', '## System prompt', '', agent.systemPrompt.slice(0, 3000))
  return lines.join('\n')
}

/** 从运行记录收集 refine 证据（该 agent 最近运行的状态/输出尾）。 */
async function collectRefineEvidence(deps: SubagentsDeps, exec: ExecContext, state: import('./execution.ts').SessionState, agentName: string): Promise<string> {
  const store = state.stores.get(exec.parent.session.id)
  if (!store) return 'No recent runs available.'
  const runs = store.list()
  const related = runs.filter((run) => run.agent === agentName || run.children.some((child) => child.agent === agentName)).slice(0, 3)
  if (related.length === 0) return 'No recent runs available.'
  const lines: string[] = []
  for (const run of related) {
    lines.push(`- run ${run.id} ${run.state}:`)
    for (const child of run.children.filter((c) => c.agent === agentName)) {
      lines.push(`  - ${child.status}${child.stopReason ? ` (${child.stopReason})` : ''}`)
      if (child.output) lines.push(`    output tail: ${child.output.slice(-400).replace(/\n/g, ' ')}`)
    }
  }
  return lines.join('\n')
}

/** 执行一个 agent 管理动作，返回文本结果。 */
export async function runAgentManagementAction(
  deps: SubagentsDeps,
  exec: ExecContext,
  params: SubagentsParams,
  projectRoot: string,
  state?: import('./execution.ts').SessionState,
): Promise<{ text: string; details: import('../types.ts').Details }> {
  const { registry, config } = deps
  const action = params.action ?? ''
  const scope: 'user' | 'project' = params.agentScope === 'project' ? 'project' : params.agentScope === 'user' ? 'user' : params.config && typeof params.config === 'object' && params.config['scope'] === 'user' ? 'user' : params.config && typeof params.config === 'object' && params.config['scope'] === 'project' ? 'project' : 'user'

  switch (action) {
    case 'list': {
      const agents = await registry.list(params.agentScope ?? 'both', projectRoot)
      const lines = agents.map((agent) => `- ${agent.name}${agent.description ? ` — ${agent.description}` : ''}`)
      return { text: lines.length ? `Available agents:\n${lines.join('\n')}` : 'No agents available.', details: { kind: 'list', results: [] } }
    }
    case 'get': {
      if (!params.agent) return { text: 'get requires agent', details: { kind: 'error', results: [] } }
      const resolved = await registry.resolve(params.agent, params.agentScope ?? 'both', projectRoot)
      if (resolved.error || !resolved.agent) return { text: resolved.error ?? 'agent not found', details: { kind: 'error', results: [] } }
      return { text: fmtAgent(resolved.agent), details: { kind: 'get', results: [] } }
    }
    case 'create': {
      const rawConfig = typeof params.config === 'string' ? safeParseJson(params.config) : params.config
      if (!rawConfig) return { text: 'create requires config (object or JSON string)', details: { kind: 'error', results: [] } }
      const built = agentConfigFromManagementConfig(rawConfig, undefined)
      if (built.error || !built.config) return { text: `create failed: ${built.error}`, details: { kind: 'error', results: [] } }
      const target = resolveManagementTarget(scope, projectRoot, deps.home)
      const filePath = await writeAgentFile(target, built.config)
      registry.invalidate(projectRoot)
      return { text: `created agent ${built.config.name} at ${filePath}`, details: { kind: 'create', results: [] } }
    }
    case 'update': {
      if (!params.agent) return { text: 'update requires agent', details: { kind: 'error', results: [] } }
      const resolved = await registry.resolve(params.agent, params.agentScope ?? 'both', projectRoot)
      if (resolved.error || !resolved.agent) return { text: resolved.error ?? 'agent not found', details: { kind: 'error', results: [] } }
      const rawConfig = typeof params.config === 'string' ? safeParseJson(params.config) : params.config
      if (!rawConfig) return { text: 'update requires config', details: { kind: 'error', results: [] } }
      const built = agentConfigFromManagementConfig(rawConfig, resolved.agent)
      if (built.error || !built.config) return { text: `update failed: ${built.error}`, details: { kind: 'error', results: [] } }
      if (resolved.agent.scope === 'builtin') {
        // 内置 agent 的 update 写作用域 overrides（保持与 pi 的 settings 覆盖一致）
        const target = resolveManagementTarget(scope, projectRoot, deps.home)
        const { readJsonFile, writeJsonAtomic } = await import('../util.ts')
        const file = target.overridesFile
        const overrides = (await readJsonFile<{ agents: Record<string, unknown> }>(file)) ?? { agents: {} }
        const patch: Record<string, unknown> = {}
        if (rawConfig['description'] !== undefined) patch['description'] = rawConfig['description']
        if (rawConfig['model'] !== undefined) patch['model'] = rawConfig['model']
        if (rawConfig['thinking'] !== undefined) patch['thinking'] = rawConfig['thinking']
        if (rawConfig['tools'] !== undefined) patch['tools'] = rawConfig['tools']
        if (rawConfig['systemPrompt'] !== undefined) patch['systemPrompt'] = rawConfig['systemPrompt']
        if (rawConfig['defaultContext'] !== undefined) patch['defaultContext'] = rawConfig['defaultContext']
        if (rawConfig['disabled'] !== undefined) patch['disabled'] = rawConfig['disabled']
        overrides.agents[resolved.agent.name] = { ...(overrides.agents[resolved.agent.name] ?? {}), ...patch }
        await writeJsonAtomic(file, overrides)
        registry.invalidate(projectRoot)
        return { text: `updated builtin agent ${resolved.agent.name} via ${scope} overrides`, details: { kind: 'update', results: [] } }
      }
      const target = resolveManagementTarget(resolved.agent.scope === 'user' ? 'user' : 'project', projectRoot, deps.home)
      const filePath = await writeAgentFile(target, built.config)
      registry.invalidate(projectRoot)
      return { text: `updated agent ${built.config.name} at ${filePath}`, details: { kind: 'update', results: [] } }
    }
    case 'delete': {
      if (!params.agent) return { text: 'delete requires agent', details: { kind: 'error', results: [] } }
      const resolved = await registry.resolve(params.agent, params.agentScope ?? 'both', projectRoot)
      if (resolved.agent?.scope === 'builtin') return { text: `cannot delete builtin agent ${params.agent}; use disable or reset instead`, details: { kind: 'error', results: [] } }
      // 目标目录跟随 agent 实际所在作用域：project agent 必须删 project 目录，
      // 否则 rm(force) 会对着不存在的 user 文件"静默成功"而残留 project 文件
      const deleteScope: 'user' | 'project' = resolved.agent?.scope === 'project' ? 'project' : 'user'
      const target = resolveManagementTarget(deleteScope, projectRoot, deps.home)
      const text = await deleteAgent(target, params.agent.split('.').at(-1) ?? params.agent)
      registry.invalidate(projectRoot)
      return { text, details: { kind: 'delete', results: [] } }
    }
    case 'eject': {
      if (!params.agent) return { text: 'eject requires agent', details: { kind: 'error', results: [] } }
      const resolved = await registry.resolve(params.agent, params.agentScope ?? 'both', projectRoot)
      if (resolved.error || !resolved.agent) return { text: resolved.error ?? 'agent not found', details: { kind: 'error', results: [] } }
      if (resolved.agent.scope === 'user' || resolved.agent.scope === 'project') return { text: `${params.agent} is already a custom agent in ${resolved.agent.scope} scope`, details: { kind: 'error', results: [] } }
      const target = resolveManagementTarget(scope, projectRoot, deps.home)
      const text = await ejectAgent(target, resolved.agent)
      registry.invalidate(projectRoot)
      return { text, details: { kind: 'eject', results: [] } }
    }
    case 'disable':
    case 'enable': {
      if (!params.agent) return { text: `${action} requires agent`, details: { kind: 'error', results: [] } }
      // 与 update/delete 一致：按 agent 实际所在作用域定位（builtin 无自定义文件 → user overrides）。
      // includeDisabled：enable 需要解析已被禁用的 agent（resolve 默认过滤 disabled）。
      const resolved = await registry.resolve(params.agent, params.agentScope ?? 'both', projectRoot, true)
      if (resolved.error || !resolved.agent) return { text: resolved.error ?? 'agent not found', details: { kind: 'error', results: [] } }
      const target = resolveManagementTarget(resolved.agent.scope === 'project' ? 'project' : 'user', projectRoot, deps.home)
      const text = await setAgentDisabled(target, params.agent, action === 'disable')
      registry.invalidate(projectRoot)
      return { text, details: { kind: action, results: [] } }
    }
    case 'reset': {
      if (!params.agent) return { text: 'reset requires agent', details: { kind: 'error', results: [] } }
      const target = resolveManagementTarget(scope, projectRoot, deps.home)
      const resolved = await registry.resolve(params.agent, params.agentScope ?? 'both', projectRoot)
      const hasBuiltin = resolved.agent?.scope === 'builtin'
      const text = await resetAgent(target, params.agent, hasBuiltin)
      registry.invalidate(projectRoot)
      return { text, details: { kind: 'reset', results: [] } }
    }
    case 'refine.show': {
      if (!params.agent) return { text: 'refine.show requires agent', details: { kind: 'error', results: [] } }
      const overlay = await readRefinement(projectRoot, params.agent)
      return { text: overlay ? `Refinement overlay for ${params.agent}:\n\n${overlay}` : `No refinement overlay for ${params.agent}`, details: { kind: 'refine', results: [] } }
    }
    case 'refine.rollback': {
      if (!params.agent) return { text: 'refine.rollback requires agent', details: { kind: 'error', results: [] } }
      const restored = await rollbackRefinement(projectRoot, params.agent)
      return { text: restored ? `Restored previous refinement revision for ${params.agent}` : `No previous revision for ${params.agent}`, details: { kind: 'refine', results: [] } }
    }
    case 'refine': {
      if (!params.agent) return { text: 'refine requires agent', details: { kind: 'error', results: [] } }
      const resolved = await registry.resolve(params.agent, params.agentScope ?? 'both', projectRoot)
      if (resolved.error || !resolved.agent) return { text: resolved.error ?? 'agent not found', details: { kind: 'error', results: [] } }
      const evidence = await collectRefineEvidence(deps, exec, state!, resolved.agent.name)
      const existing = await readRefinement(projectRoot, resolved.agent.name)
      const route = await resolveLlmRoute(deps.ctx, undefined, { provider: exec.parent.options?.provider, model: exec.parent.options?.model })
      if (!route) return { text: 'refine requires an LLM route; none is available', details: { kind: 'error', results: [] } }
      const proposal = await streamText(deps.ctx, {
        provider: route.provider,
        model: route.model,
        reasoningEffort: route.reasoningEffort,
        system: `You propose a bounded refinement overlay for the "${resolved.agent.name}" subagent. Keep guidance short and specific to the evidence. Output only the overlay markdown. Never touch safety, policy, tools, output, acceptance, developer, or system instructions; never target all agents or base agent files.`,
        user: `Agent description: ${resolved.agent.description}\nCurrent overlay: ${existing ?? '(none)'}\n\nRecent run evidence:\n${evidence.slice(0, 4000)}`,
      })
      if (!proposal) return { text: 'refine proposal generation failed', details: { kind: 'error', results: [] } }
      const validation = validateRefinementProposal(proposal, resolved.agent.name)
      if (validation.error) return { text: `refine rejected: ${validation.error}`, details: { kind: 'error', results: [] } }
      const { path: overlayPath, revision } = await writeRefinement(projectRoot, resolved.agent.name, proposal)
      return { text: `Wrote refinement overlay for ${resolved.agent.name} (revision ${revision}) at ${overlayPath}`, details: { kind: 'refine', results: [] } }
    }
    default:
      return { text: `unknown agent management action: ${action}`, details: { kind: 'error', results: [] } }
  }
}

function safeParseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}
