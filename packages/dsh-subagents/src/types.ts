/**
 * 共享类型：插件配置、Agent 配置、运行记录、工具参数与结果详情。
 */

import type { SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** 前台单次运行默认超时：30 分钟（与 pi-subagents 一致）。 */
export const DEFAULT_FOREGROUND_TIMEOUT_MS = 30 * 60_000
/** 单次运行树的默认累计子代理上限。 */
export const DEFAULT_MAX_SPAWNS_PER_RUN = 64
/** 默认嵌套委派深度上限：主会话 → 子代理 → 子-子代理。 */
export const DEFAULT_MAX_SUBAGENT_DEPTH = 2
/** 工作流脚本默认上限。 */
export const MAX_WORKFLOW_SCRIPT_LENGTH = 200_000
/** mission state.json 大小上限。 */
export const MISSION_STATE_LIMIT_BYTES = 256 * 1024
/** gate 验证命令的默认执行超时（毫秒）。 */
export const DEFAULT_GATE_TIMEOUT_MS = 120_000
/** 每个会话保留的可 resume 子代理上限。 */
export const MAX_RETAINED_CHILDREN = 10
/** 调度 ticker 的轮询间隔（毫秒）。 */
export const SCHEDULE_TICKER_INTERVAL_MS = 15_000
/** 调度回执/事件历史保留条数。 */
export const SCHEDULE_HISTORY_KEEP = 50
/** workflow 脚本同步执行保护上限（毫秒；异步等待由运行级超时约束）。 */
export const MAX_WORKFLOW_SYNC_TIMEOUT_MS = 60_000
/** 子代理输出默认截断长度（可用 maxOutput.maxChars 覆盖）。 */
export const DEFAULT_MAX_OUTPUT_CHARS = 200_000

/** 内置 agent 目录（包内 agents/）。 */
export const BUILTIN_AGENT_DIR = 'agents'
/** 用户 agent 目录（~/.dsh/subagents/agents）。 */
export const USER_AGENT_DIR = 'subagents/agents'
/** 项目 agent 目录（<root>/.dsh/subagents/agents）。 */
export const PROJECT_AGENT_DIR = 'subagents/agents'
/** 项目数据目录（<root>/.dsh/subagents）。 */
export const PROJECT_DATA_DIR = 'subagents'

export type AgentScope = 'user' | 'project' | 'both'

/** 插件配置（port pi-subagents config.json + settings 中 subagents.* 的子集）。 */
export interface SubagentsConfig {
  /** parent-facing 工具描述模式：full | compact | custom。 */
  toolDescriptionMode: 'full' | 'compact' | 'custom'
  /** workflowScript 缺省 async（默认 true）。 */
  asyncByDefault: boolean
  /** 全局默认运行时上限（毫秒）；缺省前台 30 分钟。 */
  timeoutMs?: number
  /** 可选全局硬性单工具调用上限（毫秒）；dsh 子代理无法在子进程内强制，仅记录。 */
  toolTimeoutMs?: number
  /** `gate` 验证命令的执行超时（毫秒）；缺省 120 秒。 */
  gateTimeoutMs?: number
  /** 会话累计子代理启动上限；0 = 无限。 */
  maxSubagentSpawnsPerSession?: number
  /** 单次运行树累计逻辑子代理上限；缺省 64。 */
  maxSubagentSpawnsPerRun?: number
  /** 会话并发顶层后台运行上限；0/缺省 = 无限。 */
  maxActiveAsyncRunsPerSession?: number
  /** 嵌套委派深度上限；缺省 2。 */
  maxSubagentDepth?: number
  /** 默认子代理模型（parent 会话模型之上的默认）。 */
  defaultModel?: string
  /** 默认 thinking 级别。 */
  defaultThinking?: string | false
  /** 按 agent 名的覆盖（对应 pi 的 agentOverrides）。 */
  agentOverrides?: Record<string, AgentOverride>
  /** 一次性禁用所有内置 agents。 */
  disableBuiltins?: boolean
  /** 并行参数。 */
  parallel: { maxTasks: number; concurrency: number }
  /** mission 存储配置。 */
  missions: {
    enabled: boolean
    directory?: string
    retainTerminal: number
    globalIndex: boolean
  }
  /** 调度配置。 */
  scheduledRuns: { enabled: boolean; storeRoot?: string; maxPending: number }
  /** intercom bridge 配置。 */
  intercomBridge: { mode: 'always' | 'fork-only' | 'off'; instructionFile?: string; resultDelivery: boolean }
  /** watchdog 配置。 */
  watchdog: WatchdogConfig
  /** 子代理工具权限规则（全局）。 */
  permissions: { rules: Record<string, 'allow' | 'ask' | 'deny'> }
  /** 能力上限（对齐上游 capability-ceiling）：受限工具移除、受限 agent 拒绝。 */
  capabilityCeiling?: {
    version: 1
    allowedTools?: string[]
    allowedAgents?: string[]
    denyExtensions: boolean
    sources: string[]
  }
  /** 调试产物目录偏好（project | session | temp）。 */
  artifactDir: 'project' | 'session' | 'temp'
  /** 强制顶层 async。 */
  forceTopLevelAsync: boolean
  /** wait 工具开关。 */
  waitTool: { enabled: boolean }
}

/** 按 agent 的覆盖字段（对应 pi agentOverrides）。 */
export interface AgentOverride {
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

/** watchdog 配置（对齐上游 ResolvedWatchdogConfig 的字段面；缺省值见 watchdog/settings.ts）。 */
export interface WatchdogConfig {
  enabled: boolean
  delivery?: 'held'
  showDuringRun?: boolean
  syncBacklog?: 'off' | number
  agentEndTimeoutMs?: number
  lateWarningPolicy?: 'show-stale-no-autofollow'
  severityThreshold?: 'concern' | 'blocker'
  maxWarnings?: number | null
  guidance?: { watchdogMd?: boolean; systemPromptPath?: string | null }
  autoFollow: { blockers: boolean; maxAttempts: number; stalemateRepeats: number }
  scope: { enabled: boolean }
  cadence: { everyNTools?: number | null }
  main: { model?: string; thinking?: string | false }
  children: {
    enabled?: boolean
    model?: string
    thinking?: string | false
    watchdogTailTimeoutMs?: number
    autoFollow?: { blockers?: boolean; maxAttempts?: number | null; stalemateRepeats?: number }
    overrides: Record<string, { enabled?: boolean; model?: string; thinking?: string | false }>
  }
  asyncCompletion?: { enabled?: boolean; autoFollowBlockers?: boolean }
  lsp?: { enabled?: boolean; timeoutMs?: number; maxFiles?: number; maxDiagnostics?: number }
  compactAtPercent?: number
  reviewRetryDelayMs?: number
  maxReviewFailures?: number
}

/** 已解析的 Agent 配置。 */
export interface AgentConfig {
  /** 运行时名（`package.name` 或 `name`）。 */
  name: string
  /** frontmatter 本地名。 */
  localName: string
  packageName?: string
  description: string
  aliases?: string[]
  /** 严格子代理工具白名单；缺省 = 继承 parent 全部工具。 */
  tools?: string[]
  /** 兼容字段：子代理扩展加载（dsh 不适用，仅记录）。 */
  extensions?: string[]
  model?: string
  fallbackModels?: string[]
  thinking?: string | false
  systemPromptMode?: 'replace' | 'append'
  inheritProjectContext?: boolean
  inheritSkills?: boolean
  skills?: string[]
  skillPath?: string[]
  output?: string | false
  defaultReads?: string[]
  defaultProgress?: boolean
  defaultContext?: 'fresh' | 'fork'
  async?: boolean
  timeoutMs?: number
  toolTimeoutMs?: number
  turnBudget?: { maxTurns: number; graceTurns?: number }
  acceptance?: AcceptanceSpec
  acceptanceRole?: 'read-only' | 'writer'
  completionGuard?: boolean
  maxSubagentDepth?: number
  disabled?: boolean
  memory?: { scope: 'project' | 'user'; path: string }
  /** 系统提示正文。 */
  systemPrompt: string
  /** 来源文件（builtin 为包内路径，user/project 为绝对路径）。 */
  file?: string
  scope: 'builtin' | 'user' | 'project'
}

/** 验收配置。 */
export interface AcceptanceSpec {
  level?: 'auto' | 'none' | 'attested' | 'checked' | 'verified'
  reason?: string
  criteria?: string[]
  evidence?: string[]
  verify?: Array<{ id?: string; command: string; timeoutMs?: number }>
  review?: { required?: boolean; agent?: string }
}

/** 运行状态。 */
export type RunState = 'queued' | 'running' | 'paused' | 'needs_attention' | 'completed' | 'failed' | 'stopped' | 'timed_out'

/** 子代理运行模式。 */
export type RunMode = 'single' | 'workflow'

/** 结果行（一个逻辑子代理的终态摘要）。 */
export interface ResultRow {
  index: number
  key?: string
  runId?: string
  agent: string
  task: string
  status: RunState
  exitCode: number
  startedAt?: number
  endedAt?: number
  output?: string
  outputFile?: string
  sessionFile?: string
  model?: string
  attemptedModels?: string[]
  toolCount?: number
  turnCount?: number
  totalTokens?: number
  totalCost?: number
  stopReason?: string
  evidenceStatus?: string
  resumable?: boolean
  missionId?: string
  /** structuredOutputSchema 校验后的结构化结果。 */
  structuredOutput?: unknown
}

/** 运行记录（内存 + 磁盘 status.json 投影）。 */
export interface RunRecord {
  id: string
  mode: RunMode
  state: RunState
  agent: string
  goal?: string
  cwd: string
  sessionId: string
  missionId?: string
  missionWarning?: string
  asyncDir?: string
  jobId?: string
  startedAt: number
  lastUpdate: number
  endedAt?: number
  durationMs?: number
  timeoutMs?: number
  workflowGraph?: string
  children: ChildRecord[]
  results: ResultRow[]
  spawnCount: number
  totalTokens?: number
  totalCost?: number
  usage: { tokens?: number; costUsd?: number }
  stopReason?: string
  /** 该运行是否仍在进行（供 status 过滤）。 */
  active: boolean
}

/** 子代理运行期记录（含非序列化的运行句柄）。 */
export interface ChildRecord {
  index: number
  key?: string
  runId?: string
  agent: string
  task: string
  status: RunState
  startedAt: number
  endedAt?: number
  output?: string
  outputFile?: string
  sessionFile?: string
  model?: string
  attemptedModels?: string[]
  toolCount?: number
  turnCount?: number
  totalTokens?: number
  totalCost?: number
  stopReason?: string
  evidenceStatus?: string
  resumable?: boolean
  /** structuredOutputSchema 校验后的结构化结果。 */
  structuredOutput?: unknown
  run?: SubagentRun
  localAgent?: Agent
  /** 完成后的 follow_up 简短待办（下次 resume 时作为首条简报）。 */
  followUpBrief?: string
  /** 回合结束时仍有未答复的 supervisor 请求：run 保持 active 等待父回复。 */
  awaitingSupervisor?: boolean
}

/** 工具参数（port pi-subagents subagent 参数子集）。 */
export interface SubagentsParams {
  agent?: string
  task?: string
  action?: string
  topic?: string
  config?: Record<string, unknown> | string
  agentScope?: AgentScope
  context?: 'fresh' | 'fork'
  async?: boolean
  workflowScript?: string
  missionId?: string
  mission?: Record<string, unknown> | false
  timeoutMs?: number
  maxRuntimeMs?: number
  toolTimeoutMs?: number
  turnBudget?: { maxTurns: number; graceTurns?: number }
  toolBudget?: { soft?: number; hard?: number; block?: string[] | '*' }
  usageBudget?: { tokens?: { soft?: number; hard?: number }; costUsd?: { soft?: number; hard?: number } }
  acceptance?: AcceptanceSpec | string | false
  gate?: string
  cwd?: string
  maxOutput?: { maxChars?: number; maxLines?: number }
  includeProgress?: boolean
  share?: boolean
  sessionDir?: string
  /** 结构化输出 JSON Schema：child 必须以符合 schema 的结构化结果收尾（dsh 平台原生 outputSchema）。 */
  structuredOutputSchema?: Record<string, unknown>
  index?: number
  lines?: number
  mode?: 'steer' | 'follow_up' | 'auto'
  view?: 'fleet' | 'transcript'
  step?: unknown
  resume?: string
  at?: string
  every?: string
  name?: string
  message?: string
  id?: string
  runId?: string
  decisionId?: string
  missionScope?: 'project' | 'global'
  creatorSessionId?: string
  additional?: number
  scope?: 'session' | 'user' | 'project'
  target?: 'main' | 'children' | 'child'
  thinking?: string | false
  model?: string
  replyTo?: string
  focus?: boolean
  /** mission.update 的更新对象（对齐上游 missionUpdate 参数面）。 */
  missionUpdate?: Record<string, unknown>
  /** mission.create / mission.close 的目标状态（对齐上游 missionStatus）。 */
  missionStatus?: string
  /** mission.attach-run 的附加 run 模式（对齐上游 runMode）。 */
  runMode?: string
  /** mission.attach-run 的附加 run 状态（对齐上游 runStatus）。 */
  runStatus?: string
  handoffPath?: string
}

/** 工具结果详情。 */
export interface Details {
  kind: string
  runId?: string
  mode?: RunMode
  state?: RunState
  agent?: string
  results: ResultRow[]
  totalTokens?: number
  totalCost?: number
  missionId?: string
  missionWarning?: string
  asyncDir?: string
  progress?: Array<{ key: string; agent: string; status: string }>
  fleet?: FleetEntry[]
  totalActive?: number
  text?: string
  /** debug.run 事件诊断条数。 */
  events?: number
}

/** fleet 状态条目。 */
export interface FleetEntry {
  agent: string
  state: string
  elapsedMs: number
  tokens?: number
  goal?: string
}

/** supervisor 请求（intercom）。 */
export interface SupervisorRequest {
  id: string
  childSessionId: string
  childAgent: string
  parentSessionId: string
  reason: 'need_decision' | 'interview_request' | 'progress_update'
  message: string
  status: 'pending' | 'answered'
  createdAt: number
  answeredAt?: number
  reply?: string
}

/** 保留子代理（可 resume）。 */
export interface RetainedChild {
  runId: string
  index: number
  agent: string
  key?: string
  task: string
  output: string
  resumable: boolean
  reason?: string
  missionId?: string
}

/** 目录常量。 */
export const DIRS = {
  /** 运行产物根（os tmp）。 */
  get async(): string {
    return `${process.env.TMPDIR ?? '/tmp'}/dsh-subagents-runs`
  },
  /** 结果根。 */
  get results(): string {
    return `${process.env.TMPDIR ?? '/tmp'}/dsh-subagents-results`
  },
} as const
