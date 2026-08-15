/**
 * 启动契约预检（对应 pi-subagents/preflight）：副作用自由的单代理启动解析。
 * 供其他插件在决定启动前检查解析结果。
 */

import type { AgentConfig } from './types.ts'
import { AgentRegistry } from './agents/registry.ts'
import { resolveAgentModelRoute } from './runs/spawn.ts'
import { resolveProjectRoot } from './util.ts'

/** 预检输入：目标 agent、任务与可选的运行环境信息。 */
export interface PreflightInput {
  agent: string
  task?: string
  context?: 'fresh' | 'fork'
  cwd: string
  sessionRoot?: string
  availableModels?: Array<{ provider: string; model: string }>
  home?: string
  config?: import('./types.ts').SubagentsConfig
}

/** 预检通过的启动契约（供调用方决定是否启动）。 */
export interface PreflightContract {
  digest: string
  agent: string
  context: 'fresh' | 'fork'
  provider: string
  model?: string
  tools: { effectiveAllowlist?: string[] }
  systemPromptMode?: string
  defaultReads?: string[]
  timeoutMs?: number
  acceptance?: unknown
}

/** 预检结果：ok 时携带契约，否则携带可操作错误信息。 */
export interface PreflightResult {
  ok: boolean
  contract?: PreflightContract
  message?: string
}

/**
 * 解析单代理启动契约。无副作用：不创建会话、不写产物、不启动子代理。
 */
export async function resolveSubagentLaunchContract(input: PreflightInput): Promise<PreflightResult> {
  if (!input.agent || !input.agent.trim()) return { ok: false, message: 'missing_agent: `agent` is required' }
  const cwd = input.cwd || process.cwd()
  const projectRoot = resolveProjectRoot(cwd)
  const config = input.config ?? defaultConfig()
  const registry = new AgentRegistry(config, input.home ?? process.env.HOME ?? '')
  const resolved = await registry.resolve(input.agent, 'both', projectRoot)
  if (!resolved.agent) return { ok: false, message: `missing_agent: ${resolved.error}` }
  if (resolved.viaAlias && resolved.agent.aliases && resolved.agent.aliases.length > 1) {
    return { ok: false, message: 'ambiguous_agent: alias resolves to multiple agents' }
  }
  const context = input.context ?? resolved.agent.defaultContext ?? 'fresh'
  const provider = context === 'fork' ? 'fork' : 'spawn'
  const route = resolveAgentModelRoute(resolved.agent, config, {
    provider: input.availableModels?.[0]?.provider,
    model: input.availableModels?.[0]?.model,
  })
  const allowlist = resolved.agent.tools
  if (allowlist && input.availableModels && input.availableModels.length === 0 && resolved.agent.tools?.includes('web_search')) {
    return { ok: false, message: 'denied_required_tool: web_search requires a configured search provider' }
  }
  const digest = [
    resolved.agent.name,
    context,
    provider,
    route.model ?? 'inherit',
    allowlist?.join(',') ?? 'inherit-all',
    resolved.agent.systemPromptMode ?? 'replace',
  ].join('|')
  return {
    ok: true,
    contract: {
      digest,
      agent: resolved.agent.name,
      context,
      provider,
      model: route.model,
      tools: { effectiveAllowlist: allowlist },
      systemPromptMode: resolved.agent.systemPromptMode,
      defaultReads: resolved.agent.defaultReads,
      timeoutMs: resolved.agent.timeoutMs,
      acceptance: resolved.agent.acceptance,
    },
  }
}

function defaultConfig(): import('./types.ts').SubagentsConfig {
  // 用最小默认（不读取 cordis 配置）；调用方应传入真实配置
  return {
    toolDescriptionMode: 'compact',
    asyncByDefault: true,
    maxSubagentSpawnsPerRun: 64,
    maxSubagentDepth: 2,
    parallel: { maxTasks: 8, concurrency: 4 },
    missions: { enabled: true, retainTerminal: 200, globalIndex: true },
    scheduledRuns: { enabled: true, maxPending: 20 },
    intercomBridge: { mode: 'always', resultDelivery: false },
    watchdog: { enabled: false, main: {}, children: { overrides: {} }, scope: { enabled: false }, cadence: {}, autoFollow: { blockers: false, maxAttempts: 3, stalemateRepeats: 3 } },
    permissions: { rules: {} },
    artifactDir: 'temp',
    forceTopLevelAsync: false,
    waitTool: { enabled: true },
  }
}

export type { AgentConfig }
