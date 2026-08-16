/**
 * 插件配置 Schema 与默认值（port pi-subagents config.json + settings 子集）。
 * 嵌套对象不做 .default（由 normalizeConfig 补默认），标量字段用 .default。
 */

import Schema from '@deepseek-ai/schemastery'
import { normalizeCeiling, type SubagentCapabilityCeiling } from './runs/capability-ceiling.ts'

export interface Config {
  toolDescriptionMode?: 'full' | 'compact' | 'custom'
  asyncByDefault?: boolean
  timeoutMs?: number
  toolTimeoutMs?: number
  gateTimeoutMs?: number
  maxSubagentSpawnsPerSession?: number
  maxSubagentSpawnsPerRun?: number
  maxActiveAsyncRunsPerSession?: number
  maxSubagentDepth?: number
  defaultModel?: string
  defaultThinking?: string | false
  agentOverrides?: Record<string, AgentOverrideConfig>
  disableBuiltins?: boolean
  parallel?: { maxTasks?: number; concurrency?: number }
  missions?: { enabled?: boolean; directory?: string; retainTerminal?: number; globalIndex?: boolean }
  scheduledRuns?: { enabled?: boolean; storeRoot?: string; maxPending?: number }
  intercomBridge?: { mode?: 'always' | 'fork-only' | 'off'; instructionFile?: string; resultDelivery?: boolean }
  watchdog?: WatchdogConfig
  permissions?: { rules?: Record<string, 'allow' | 'ask' | 'deny'> }
  artifactDir?: 'project' | 'session' | 'temp'
  forceTopLevelAsync?: boolean
  waitTool?: { enabled?: boolean }
  /** 能力上限（对齐上游 capability-ceiling）：受限工具被移除、受限 agent 被拒绝。 */
  capabilityCeiling?: {
    allowedTools?: string[]
    allowedAgents?: string[]
    denyExtensions?: boolean
  }
}

export interface AgentOverrideConfig {
  description?: string
  model?: string
  fallbackModels?: string[]
  thinking?: string | false
  systemPromptMode?: 'replace' | 'append'
  inheritProjectContext?: boolean
  inheritSkills?: boolean
  defaultContext?: 'fresh' | 'fork'
  acceptanceRole?: 'read-only' | 'writer' | false
  disabled?: boolean
  skills?: string[] | false
  tools?: string[] | 'inherit' | false
  systemPrompt?: string
}

export interface WatchdogConfig {
  enabled?: boolean
  delivery?: 'held'
  showDuringRun?: boolean
  syncBacklog?: 'off' | number
  agentEndTimeoutMs?: number
  lateWarningPolicy?: 'show-stale-no-autofollow'
  severityThreshold?: 'concern' | 'blocker'
  maxWarnings?: number | null
  guidance?: { watchdogMd?: boolean; systemPromptPath?: string | null }
  main?: { model?: string; thinking?: string | false }
  children?: {
    enabled?: boolean
    model?: string
    thinking?: string | false
    watchdogTailTimeoutMs?: number
    autoFollow?: { blockers?: boolean; maxAttempts?: number | null; stalemateRepeats?: number }
    overrides?: Record<string, { enabled?: boolean; model?: string; thinking?: string | false }>
  }
  scope?: { enabled?: boolean }
  cadence?: { everyNTools?: number | null }
  autoFollow?: { blockers?: boolean; maxAttempts?: number; stalemateRepeats?: number }
  asyncCompletion?: { enabled?: boolean; autoFollowBlockers?: boolean }
  lsp?: { enabled?: boolean; timeoutMs?: number; maxFiles?: number; maxDiagnostics?: number }
  compactAtPercent?: number
  reviewRetryDelayMs?: number
  maxReviewFailures?: number
}

const AgentOverrideSchema = Schema.object({
  description: Schema.string(),
  model: Schema.string(),
  fallbackModels: Schema.array(Schema.string()),
  thinking: Schema.union([Schema.string(), Schema.const(false)]),
  systemPromptMode: Schema.union([Schema.const('replace'), Schema.const('append')]),
  inheritProjectContext: Schema.boolean(),
  inheritSkills: Schema.boolean(),
  defaultContext: Schema.union([Schema.const('fresh'), Schema.const('fork')]),
  acceptanceRole: Schema.union([Schema.const('read-only'), Schema.const('writer'), Schema.const(false)]),
  disabled: Schema.boolean(),
  skills: Schema.union([Schema.array(Schema.string()), Schema.const(false)]),
  tools: Schema.union([Schema.array(Schema.string()), Schema.const('inherit'), Schema.const(false)]),
  systemPrompt: Schema.string(),
})

const WatchdogChildOverrideSchema = Schema.object({
  enabled: Schema.boolean(),
  model: Schema.string(),
  thinking: Schema.union([Schema.string(), Schema.const(false)]),
})

const WatchdogAutoFollowSchema = Schema.object({
  blockers: Schema.boolean(),
  maxAttempts: Schema.union([Schema.natural(), Schema.const(null)]),
  stalemateRepeats: Schema.natural(),
})

const WatchdogSchema = Schema.object({
  enabled: Schema.boolean(),
  delivery: Schema.const('held'),
  showDuringRun: Schema.boolean(),
  syncBacklog: Schema.union([Schema.const('off'), Schema.natural()]),
  agentEndTimeoutMs: Schema.natural(),
  lateWarningPolicy: Schema.const('show-stale-no-autofollow'),
  severityThreshold: Schema.union([Schema.const('concern'), Schema.const('blocker')]),
  maxWarnings: Schema.union([Schema.natural(), Schema.const(null)]),
  guidance: Schema.object({
    watchdogMd: Schema.boolean(),
    systemPromptPath: Schema.union([Schema.string(), Schema.const(null)]),
  }),
  main: Schema.object({
    model: Schema.string(),
    thinking: Schema.union([Schema.string(), Schema.const(false)]),
  }),
  children: Schema.object({
    enabled: Schema.boolean(),
    model: Schema.string(),
    thinking: Schema.union([Schema.string(), Schema.const(false)]),
    watchdogTailTimeoutMs: Schema.natural(),
    autoFollow: WatchdogAutoFollowSchema,
    overrides: Schema.dict(WatchdogChildOverrideSchema),
  }),
  scope: Schema.object({
    enabled: Schema.boolean(),
  }),
  cadence: Schema.object({
    everyNTools: Schema.union([Schema.natural(), Schema.const(null)]),
  }),
  autoFollow: WatchdogAutoFollowSchema,
  asyncCompletion: Schema.object({
    enabled: Schema.boolean(),
    autoFollowBlockers: Schema.boolean(),
  }),
  lsp: Schema.object({
    enabled: Schema.boolean(),
    timeoutMs: Schema.natural(),
    maxFiles: Schema.natural(),
    maxDiagnostics: Schema.natural(),
  }),
  compactAtPercent: Schema.natural(),
  reviewRetryDelayMs: Schema.natural(),
  maxReviewFailures: Schema.natural(),
})

/**
 * 插件配置 Schema（经 Schema 校验后由 normalizeConfig 规范为运行时配置）。
 */
export const Config: Schema<Config> = Schema.object({
  toolDescriptionMode: Schema.union([Schema.const('full'), Schema.const('compact'), Schema.const('custom')]).default('compact'),
  asyncByDefault: Schema.boolean().default(true),
  timeoutMs: Schema.natural().max(2_147_483_647),
  toolTimeoutMs: Schema.natural().max(2_147_483_647),
  gateTimeoutMs: Schema.natural().max(2_147_483_647),
  maxSubagentSpawnsPerSession: Schema.natural(),
  maxSubagentSpawnsPerRun: Schema.natural().default(64),
  maxActiveAsyncRunsPerSession: Schema.natural(),
  maxSubagentDepth: Schema.natural().default(2),
  defaultModel: Schema.string(),
  defaultThinking: Schema.union([Schema.string(), Schema.const(false)]),
  agentOverrides: Schema.dict(AgentOverrideSchema),
  disableBuiltins: Schema.boolean().default(false),
  parallel: Schema.object({
    maxTasks: Schema.natural().default(8),
    concurrency: Schema.natural().default(4),
  }),
  missions: Schema.object({
    enabled: Schema.boolean().default(true),
    directory: Schema.string(),
    retainTerminal: Schema.natural().default(200),
    globalIndex: Schema.boolean().default(true),
  }),
  scheduledRuns: Schema.object({
    enabled: Schema.boolean().default(true),
    storeRoot: Schema.string(),
    maxPending: Schema.natural().default(20),
  }),
  intercomBridge: Schema.object({
    mode: Schema.union([Schema.const('always'), Schema.const('fork-only'), Schema.const('off')]).default('always'),
    instructionFile: Schema.string(),
    resultDelivery: Schema.boolean().default(false),
  }),
  watchdog: WatchdogSchema,
  permissions: Schema.object({
    rules: Schema.dict(Schema.union([Schema.const('allow'), Schema.const('ask'), Schema.const('deny')])),
  }),
  artifactDir: Schema.union([Schema.const('project'), Schema.const('session'), Schema.const('temp')]).default('temp'),
  forceTopLevelAsync: Schema.boolean().default(false),
  waitTool: Schema.object({
    enabled: Schema.boolean().default(true),
  }),
  capabilityCeiling: Schema.object({
    // Schemastery arrays default to []; preserve absence so an omitted sibling
    // does not become an accidental deny-all allowlist.
    allowedTools: Schema.array(Schema.string()).default(undefined as never),
    allowedAgents: Schema.array(Schema.string()).default(undefined as never),
    denyExtensions: Schema.boolean(),
  }),
}) as Schema<Config>

/** 把（已校验的）配置规范为运行时 SubagentsConfig。 */
export function normalizeConfig(raw: Config): import('./types.ts').SubagentsConfig {
  const missions = raw.missions ?? {}
  const scheduledRuns = raw.scheduledRuns ?? {}
  const watchdog = raw.watchdog ?? {}
  const parallel = raw.parallel ?? {}
  const intercomBridge = raw.intercomBridge ?? {}
  const permissions = raw.permissions ?? {}
  const waitTool = raw.waitTool ?? {}
  const rawCeiling = raw.capabilityCeiling
  const capabilityCeiling = rawCeiling && Object.keys(rawCeiling).length > 0
    ? normalizeCeiling(rawCeiling as SubagentCapabilityCeiling)
    : undefined
  return {
    toolDescriptionMode: raw.toolDescriptionMode ?? 'compact',
    asyncByDefault: raw.asyncByDefault ?? true,
    timeoutMs: raw.timeoutMs,
    toolTimeoutMs: raw.toolTimeoutMs,
    gateTimeoutMs: raw.gateTimeoutMs,
    maxSubagentSpawnsPerSession: raw.maxSubagentSpawnsPerSession,
    maxSubagentSpawnsPerRun: raw.maxSubagentSpawnsPerRun ?? 64,
    maxActiveAsyncRunsPerSession: raw.maxActiveAsyncRunsPerSession,
    maxSubagentDepth: raw.maxSubagentDepth ?? 2,
    defaultModel: raw.defaultModel,
    defaultThinking: raw.defaultThinking,
    agentOverrides: raw.agentOverrides ?? {},
    disableBuiltins: raw.disableBuiltins ?? false,
    parallel: { maxTasks: parallel.maxTasks ?? 8, concurrency: parallel.concurrency ?? 4 },
    missions: {
      enabled: missions.enabled ?? true,
      directory: missions.directory,
      retainTerminal: missions.retainTerminal ?? 200,
      globalIndex: missions.globalIndex ?? true,
    },
    scheduledRuns: {
      enabled: scheduledRuns.enabled ?? true,
      storeRoot: scheduledRuns.storeRoot,
      maxPending: scheduledRuns.maxPending ?? 20,
    },
    intercomBridge: {
      mode: intercomBridge.mode ?? 'always',
      instructionFile: intercomBridge.instructionFile,
      resultDelivery: intercomBridge.resultDelivery ?? false,
    },
    watchdog: {
      enabled: watchdog.enabled ?? false,
      delivery: watchdog.delivery,
      showDuringRun: watchdog.showDuringRun,
      syncBacklog: watchdog.syncBacklog,
      agentEndTimeoutMs: watchdog.agentEndTimeoutMs,
      lateWarningPolicy: watchdog.lateWarningPolicy,
      severityThreshold: watchdog.severityThreshold,
      maxWarnings: watchdog.maxWarnings,
      guidance: watchdog.guidance,
      main: watchdog.main ?? {},
      children: {
        enabled: watchdog.children?.enabled,
        model: watchdog.children?.model,
        thinking: watchdog.children?.thinking,
        watchdogTailTimeoutMs: watchdog.children?.watchdogTailTimeoutMs,
        autoFollow: watchdog.children?.autoFollow,
        overrides: watchdog.children?.overrides ?? {},
      },
      // scope 默认开（对齐上游 DEFAULT_WATCHDOG_CONFIG）
      scope: { enabled: watchdog.scope?.enabled ?? true },
      cadence: watchdog.cadence ?? {},
      autoFollow: { blockers: watchdog.autoFollow?.blockers ?? true, maxAttempts: watchdog.autoFollow?.maxAttempts ?? 3, stalemateRepeats: watchdog.autoFollow?.stalemateRepeats ?? 3 },
      asyncCompletion: watchdog.asyncCompletion,
      lsp: watchdog.lsp,
      compactAtPercent: watchdog.compactAtPercent,
      reviewRetryDelayMs: watchdog.reviewRetryDelayMs,
      maxReviewFailures: watchdog.maxReviewFailures,
    },
    permissions: { rules: permissions.rules ?? {} },
    artifactDir: raw.artifactDir ?? 'temp',
    forceTopLevelAsync: raw.forceTopLevelAsync ?? false,
    waitTool: { enabled: waitTool.enabled ?? true },
    capabilityCeiling,
  }
}
