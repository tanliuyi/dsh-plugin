/**
 * Watchdog 配置解析与写入（对齐上游 pi-subagents src/watchdog/settings.ts）。
 *
 * 层级（低 → 高）：内置默认 → cordis 配置面（插件配置 + web 设置页覆盖）→
 * 用户文件（~/.dsh/subagents/watchdog.json）→ 项目文件（<root>/.dsh/subagents/watchdog.json）
 * → 会话级覆盖（内存，不落盘）。文件面沿用 dsh 既有的扁平 watchdog 形状
 * （{ enabled, main: {...}, ... }，不是上游的 { subagents: { watchdog: ... } } 嵌套）。
 *
 * 解析出错（非法字段）时：该源报错进 errors、其补丁被跳过；errors 非空时
 * configOk=false 且返回内置默认（对齐上游「配置错误时 watchdog 禁用」语义）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveProjectRoot } from '../util.ts'
import { parseWatchdogThinkingInput, type ThinkingLevel } from './model-selection.ts'
import type {
  ResolvedWatchdogConfig,
  WatchdogAsyncCompletionConfig,
  WatchdogAutoFollowConfig,
  WatchdogChildOverrideConfig,
  WatchdogChildrenConfig,
  WatchdogDeliveryMode,
  WatchdogEndpointConfig,
  WatchdogCadenceConfig,
  WatchdogGuidanceConfig,
  WatchdogLateWarningPolicy,
  WatchdogScopeConfig,
  WatchdogLspConfig,
  WatchdogSettingsError,
  WatchdogSettingsResult,
  WatchdogSettingsSource,
  WatchdogSeverity,
  WatchdogSyncBacklog,
} from './types.ts'
import type { WatchdogConfig as PluginWatchdogConfig } from '../types.ts'
import { WATCHDOG_DELIVERY_MODES, WATCHDOG_LATE_WARNING_POLICIES, WATCHDOG_WARNING_SEVERITIES } from './types.ts'

type WatchdogAutoFollowPatch = Partial<WatchdogAutoFollowConfig>
type WatchdogGuidancePatch = Partial<WatchdogGuidanceConfig>
type WatchdogScopePatch = Partial<WatchdogScopeConfig>
type WatchdogCadencePatch = Partial<WatchdogCadenceConfig>
type WatchdogEndpointPatch = Partial<WatchdogEndpointConfig>
type WatchdogChildOverridePatch = Partial<WatchdogChildOverrideConfig>
type WatchdogChildrenPatch = Partial<Omit<WatchdogChildrenConfig, 'autoFollow' | 'overrides'>> & {
  autoFollow?: WatchdogAutoFollowPatch
  overrides?: Record<string, WatchdogChildOverridePatch>
}
type WatchdogAsyncCompletionPatch = Partial<WatchdogAsyncCompletionConfig>
type WatchdogLspPatch = Partial<WatchdogLspConfig>

export type WatchdogSettingsWriteScope = 'user' | 'project'
export type WatchdogModelSettingsTarget =
  | { kind: 'main' }
  | { kind: 'children' }
  | { kind: 'child'; agent: string }

export interface WatchdogModelSettingsWrite {
  scope: WatchdogSettingsWriteScope
  cwd?: string
  target: WatchdogModelSettingsTarget
  model?: string | null
  thinking?: ThinkingLevel | false | null
}

type WatchdogConfigPatch = Partial<Omit<ResolvedWatchdogConfig, 'guidance' | 'autoFollow' | 'scope' | 'cadence' | 'main' | 'children' | 'asyncCompletion' | 'lsp'>> & {
  guidance?: WatchdogGuidancePatch
  autoFollow?: WatchdogAutoFollowPatch
  scope?: WatchdogScopePatch
  cadence?: WatchdogCadencePatch
  main?: WatchdogEndpointPatch
  children?: WatchdogChildrenPatch
  asyncCompletion?: WatchdogAsyncCompletionPatch
  lsp?: WatchdogLspPatch
}

export const DEFAULT_WATCHDOG_CONFIG: ResolvedWatchdogConfig = {
  enabled: false,
  delivery: 'held',
  showDuringRun: false,
  syncBacklog: 'off',
  agentEndTimeoutMs: 30_000,
  lateWarningPolicy: 'show-stale-no-autofollow',
  severityThreshold: 'concern',
  maxWarnings: null,
  guidance: {
    watchdogMd: true,
    systemPromptPath: null,
  },
  autoFollow: {
    blockers: true,
    maxAttempts: 3,
    stalemateRepeats: 3,
  },
  scope: {
    enabled: true,
  },
  cadence: {
    everyNTools: null,
  },
  main: {
    enabled: false,
  },
  children: {
    enabled: false,
    watchdogTailTimeoutMs: 120_000,
    autoFollow: {
      blockers: true,
      maxAttempts: 3,
      stalemateRepeats: 3,
    },
    overrides: {},
  },
  asyncCompletion: {
    enabled: false,
    autoFollowBlockers: false,
  },
  lsp: {
    enabled: true,
    timeoutMs: 3_000,
    maxFiles: 20,
    maxDiagnostics: 50,
  },
  compactAtPercent: 80,
  reviewRetryDelayMs: 1_000,
  maxReviewFailures: 3,
}

/** 用户级 watchdog 文件（扁平形状）。 */
export function getWatchdogUserSettingsPath(home: string): string {
  return path.join(home, '.dsh', 'subagents', 'watchdog.json')
}

/** 项目级 watchdog 文件（<root>/.dsh/subagents/watchdog.json）。 */
export function getWatchdogProjectSettingsPath(cwd: string): string {
  const root = resolveProjectRoot(cwd)
  return path.join(root, '.dsh', 'subagents', 'watchdog.json')
}

const WATCHDOG_FIELDS = new Set([
  'enabled', 'delivery', 'showDuringRun', 'syncBacklog', 'agentEndTimeoutMs', 'lateWarningPolicy',
  'severityThreshold', 'maxWarnings', 'guidance', 'autoFollow', 'scope', 'cadence', 'main', 'children',
  'asyncCompletion', 'lsp', 'compactAtPercent', 'reviewRetryDelayMs', 'maxReviewFailures',
])
const GUIDANCE_FIELDS = new Set(['watchdogMd', 'systemPromptPath'])
const AUTO_FOLLOW_FIELDS = new Set(['blockers', 'maxAttempts', 'stalemateRepeats'])
const SCOPE_FIELDS = new Set(['enabled'])
const CADENCE_FIELDS = new Set(['everyNTools'])
const ENDPOINT_FIELDS = new Set(['enabled', 'model', 'thinking'])
const CHILDREN_FIELDS = new Set(['enabled', 'model', 'thinking', 'watchdogTailTimeoutMs', 'autoFollow', 'overrides'])
const CHILD_OVERRIDE_FIELDS = new Set(['enabled', 'model', 'thinking'])
const ASYNC_COMPLETION_FIELDS = new Set(['enabled', 'autoFollowBlockers'])
const LSP_FIELDS = new Set(['enabled', 'timeoutMs', 'maxFiles', 'maxDiagnostics'])

function cloneDefaultConfig(): ResolvedWatchdogConfig {
  return {
    ...DEFAULT_WATCHDOG_CONFIG,
    guidance: { ...DEFAULT_WATCHDOG_CONFIG.guidance },
    autoFollow: { ...DEFAULT_WATCHDOG_CONFIG.autoFollow },
    scope: { ...DEFAULT_WATCHDOG_CONFIG.scope },
    cadence: { ...DEFAULT_WATCHDOG_CONFIG.cadence },
    main: { ...DEFAULT_WATCHDOG_CONFIG.main },
    children: {
      ...DEFAULT_WATCHDOG_CONFIG.children,
      autoFollow: { ...DEFAULT_WATCHDOG_CONFIG.children.autoFollow },
      overrides: {},
    },
    asyncCompletion: { ...DEFAULT_WATCHDOG_CONFIG.asyncCompletion },
    lsp: { ...DEFAULT_WATCHDOG_CONFIG.lsp },
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface ParseMeta {
  scope: 'user' | 'project' | 'session'
  path?: string
}

function sourceName(meta: ParseMeta): string {
  return meta.path ? `'${meta.path}'` : 'session override'
}

function invalid(meta: ParseMeta, field: string, expected: string): Error {
  return new Error(`Watchdog settings in ${sourceName(meta)} have invalid '${field}'; expected ${expected}.`)
}

function unknown(meta: ParseMeta, field: string): Error {
  return new Error(`Watchdog settings in ${sourceName(meta)} have unknown field '${field}'.`)
}

function assertKnownFields(input: Record<string, unknown>, allowed: Set<string>, fieldPrefix: string, meta: ParseMeta): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw unknown(meta, `${fieldPrefix}.${key}`)
  }
}

function parseObject(value: unknown, field: string, meta: ParseMeta): Record<string, unknown> {
  if (isPlainObject(value)) return value
  throw invalid(meta, field, 'an object')
}

function parseBoolean(value: unknown, field: string, meta: ParseMeta): boolean {
  if (typeof value === 'boolean') return value
  throw invalid(meta, field, 'a boolean')
}

function parseNonEmptyString(value: unknown, field: string, meta: ParseMeta): string {
  if (typeof value === 'string' && value.trim()) return value.trim()
  throw invalid(meta, field, 'a non-empty string')
}

function parseThinking(value: unknown, field: string, meta: ParseMeta): ThinkingLevel | false {
  if (value === false) return false
  if (typeof value === 'string' && (parseWatchdogThinkingInput(value) !== undefined)) return value as ThinkingLevel
  throw invalid(meta, field, `a thinking level or false`)
}

function parseInteger(value: unknown, field: string, meta: ParseMeta, expected: string, check: (value: number) => boolean): number {
  if (typeof value === 'number' && Number.isInteger(value) && check(value)) return value
  throw invalid(meta, field, expected)
}

function parseNullableInteger(value: unknown, field: string, meta: ParseMeta, expected: string, check: (value: number) => boolean): number | null {
  if (value === null) return null
  return parseInteger(value, field, meta, expected, check)
}

function parseEnum<T extends string>(value: unknown, field: string, meta: ParseMeta, values: readonly T[]): T {
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T
  throw invalid(meta, field, values.map((item) => `'${item}'`).join(' or '))
}

function parseSyncBacklog(value: unknown, field: string, meta: ParseMeta): WatchdogSyncBacklog {
  if (value === 'off') return 'off'
  return parseInteger(value, field, meta, "'off' or a positive integer", (candidate) => candidate >= 1)
}

function parseGuidancePatch(value: unknown, field: string, meta: ParseMeta): WatchdogGuidancePatch {
  const input = parseObject(value, field, meta)
  assertKnownFields(input, GUIDANCE_FIELDS, field, meta)
  const patch: WatchdogGuidancePatch = {}
  if ('watchdogMd' in input) patch.watchdogMd = parseBoolean(input.watchdogMd, `${field}.watchdogMd`, meta)
  if ('systemPromptPath' in input) {
    patch.systemPromptPath = input.systemPromptPath === null
      ? null
      : parseNonEmptyString(input.systemPromptPath, `${field}.systemPromptPath`, meta)
  }
  return patch
}

function parseAutoFollowPatch(value: unknown, field: string, meta: ParseMeta): WatchdogAutoFollowPatch {
  const input = parseObject(value, field, meta)
  assertKnownFields(input, AUTO_FOLLOW_FIELDS, field, meta)
  const patch: WatchdogAutoFollowPatch = {}
  if ('blockers' in input) patch.blockers = parseBoolean(input.blockers, `${field}.blockers`, meta)
  if ('maxAttempts' in input) {
    patch.maxAttempts = parseNullableInteger(input.maxAttempts, `${field}.maxAttempts`, meta, 'null or a positive integer', (candidate) => candidate >= 1)
  }
  if ('stalemateRepeats' in input) {
    patch.stalemateRepeats = parseInteger(input.stalemateRepeats, `${field}.stalemateRepeats`, meta, 'a positive integer', (candidate) => candidate >= 1)
  }
  return patch
}

function parseScopePatch(value: unknown, field: string, meta: ParseMeta): WatchdogScopePatch {
  const input = parseObject(value, field, meta)
  assertKnownFields(input, SCOPE_FIELDS, field, meta)
  const patch: WatchdogScopePatch = {}
  if ('enabled' in input) patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta)
  return patch
}

function parseCadencePatch(value: unknown, field: string, meta: ParseMeta): WatchdogCadencePatch {
  const input = parseObject(value, field, meta)
  assertKnownFields(input, CADENCE_FIELDS, field, meta)
  const patch: WatchdogCadencePatch = {}
  if ('everyNTools' in input) {
    patch.everyNTools = input.everyNTools === null
      ? null
      : parseInteger(input.everyNTools, `${field}.everyNTools`, meta, 'null or an integer >= 5', (candidate) => candidate >= 5)
  }
  return patch
}

function parseEndpointPatch(value: unknown, field: string, meta: ParseMeta): WatchdogEndpointPatch {
  const input = parseObject(value, field, meta)
  assertKnownFields(input, ENDPOINT_FIELDS, field, meta)
  const patch: WatchdogEndpointPatch = {}
  if ('enabled' in input) patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta)
  if ('model' in input) patch.model = parseNonEmptyString(input.model, `${field}.model`, meta)
  if ('thinking' in input) patch.thinking = parseThinking(input.thinking, `${field}.thinking`, meta)
  return patch
}

function parseChildOverridePatch(value: unknown, field: string, meta: ParseMeta): WatchdogChildOverridePatch {
  const input = parseObject(value, field, meta)
  assertKnownFields(input, CHILD_OVERRIDE_FIELDS, field, meta)
  const patch: WatchdogChildOverridePatch = {}
  if ('enabled' in input) patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta)
  if ('model' in input) patch.model = parseNonEmptyString(input.model, `${field}.model`, meta)
  if ('thinking' in input) patch.thinking = parseThinking(input.thinking, `${field}.thinking`, meta)
  return patch
}

function parseChildrenPatch(value: unknown, field: string, meta: ParseMeta): WatchdogChildrenPatch {
  const input = parseObject(value, field, meta)
  assertKnownFields(input, CHILDREN_FIELDS, field, meta)
  const patch: WatchdogChildrenPatch = {}
  if ('enabled' in input) patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta)
  if ('model' in input) patch.model = parseNonEmptyString(input.model, `${field}.model`, meta)
  if ('thinking' in input) patch.thinking = parseThinking(input.thinking, `${field}.thinking`, meta)
  if ('watchdogTailTimeoutMs' in input) {
    patch.watchdogTailTimeoutMs = parseInteger(input.watchdogTailTimeoutMs, `${field}.watchdogTailTimeoutMs`, meta, 'a positive integer', (candidate) => candidate >= 1)
  }
  if ('autoFollow' in input) patch.autoFollow = parseAutoFollowPatch(input.autoFollow, `${field}.autoFollow`, meta)
  if ('overrides' in input) {
    const overrides = parseObject(input.overrides, `${field}.overrides`, meta)
    patch.overrides = {}
    for (const [agent, override] of Object.entries(overrides)) {
      if (!agent.trim()) throw invalid(meta, `${field}.overrides`, 'agent names to be non-empty')
      patch.overrides[agent] = parseChildOverridePatch(override, `${field}.overrides.${agent}`, meta)
    }
  }
  return patch
}

function parseAsyncCompletionPatch(value: unknown, field: string, meta: ParseMeta): WatchdogAsyncCompletionPatch {
  const input = parseObject(value, field, meta)
  assertKnownFields(input, ASYNC_COMPLETION_FIELDS, field, meta)
  const patch: WatchdogAsyncCompletionPatch = {}
  if ('enabled' in input) patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta)
  if ('autoFollowBlockers' in input) patch.autoFollowBlockers = parseBoolean(input.autoFollowBlockers, `${field}.autoFollowBlockers`, meta)
  return patch
}

function parseLspPatch(value: unknown, field: string, meta: ParseMeta): WatchdogLspPatch {
  const input = parseObject(value, field, meta)
  assertKnownFields(input, LSP_FIELDS, field, meta)
  const patch: WatchdogLspPatch = {}
  if ('enabled' in input) patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta)
  if ('timeoutMs' in input) patch.timeoutMs = parseInteger(input.timeoutMs, `${field}.timeoutMs`, meta, 'a positive integer', (candidate) => candidate >= 1)
  if ('maxFiles' in input) patch.maxFiles = parseInteger(input.maxFiles, `${field}.maxFiles`, meta, 'a positive integer', (candidate) => candidate >= 1)
  if ('maxDiagnostics' in input) patch.maxDiagnostics = parseInteger(input.maxDiagnostics, `${field}.maxDiagnostics`, meta, 'a non-negative integer', (candidate) => candidate >= 0)
  return patch
}

function parseWatchdogPatch(value: unknown, field: string, meta: ParseMeta): WatchdogConfigPatch {
  const input = parseObject(value, field, meta)
  assertKnownFields(input, WATCHDOG_FIELDS, field, meta)
  const patch: WatchdogConfigPatch = {}
  if ('enabled' in input) patch.enabled = parseBoolean(input.enabled, `${field}.enabled`, meta)
  if ('delivery' in input) patch.delivery = parseEnum<WatchdogDeliveryMode>(input.delivery, `${field}.delivery`, meta, WATCHDOG_DELIVERY_MODES)
  if ('showDuringRun' in input) patch.showDuringRun = parseBoolean(input.showDuringRun, `${field}.showDuringRun`, meta)
  if ('syncBacklog' in input) patch.syncBacklog = parseSyncBacklog(input.syncBacklog, `${field}.syncBacklog`, meta)
  if ('agentEndTimeoutMs' in input) {
    patch.agentEndTimeoutMs = parseInteger(input.agentEndTimeoutMs, `${field}.agentEndTimeoutMs`, meta, 'a positive integer', (candidate) => candidate >= 1)
  }
  if ('lateWarningPolicy' in input) {
    patch.lateWarningPolicy = parseEnum<WatchdogLateWarningPolicy>(input.lateWarningPolicy, `${field}.lateWarningPolicy`, meta, WATCHDOG_LATE_WARNING_POLICIES)
  }
  if ('severityThreshold' in input) {
    patch.severityThreshold = parseEnum<WatchdogSeverity>(input.severityThreshold, `${field}.severityThreshold`, meta, WATCHDOG_WARNING_SEVERITIES)
  }
  if ('maxWarnings' in input) {
    patch.maxWarnings = parseNullableInteger(input.maxWarnings, `${field}.maxWarnings`, meta, 'null or a non-negative integer', (candidate) => candidate >= 0)
  }
  if ('guidance' in input) patch.guidance = parseGuidancePatch(input.guidance, `${field}.guidance`, meta)
  if ('autoFollow' in input) patch.autoFollow = parseAutoFollowPatch(input.autoFollow, `${field}.autoFollow`, meta)
  if ('scope' in input) patch.scope = parseScopePatch(input.scope, `${field}.scope`, meta)
  if ('cadence' in input) patch.cadence = parseCadencePatch(input.cadence, `${field}.cadence`, meta)
  if ('main' in input) patch.main = parseEndpointPatch(input.main, `${field}.main`, meta)
  if ('children' in input) patch.children = parseChildrenPatch(input.children, `${field}.children`, meta)
  if ('asyncCompletion' in input) patch.asyncCompletion = parseAsyncCompletionPatch(input.asyncCompletion, `${field}.asyncCompletion`, meta)
  if ('lsp' in input) patch.lsp = parseLspPatch(input.lsp, `${field}.lsp`, meta)
  if ('compactAtPercent' in input) {
    patch.compactAtPercent = parseInteger(input.compactAtPercent, `${field}.compactAtPercent`, meta, 'an integer from 50 through 95', (candidate) => candidate >= 50 && candidate <= 95)
  }
  if ('reviewRetryDelayMs' in input) {
    patch.reviewRetryDelayMs = parseInteger(input.reviewRetryDelayMs, `${field}.reviewRetryDelayMs`, meta, 'a positive integer', (candidate) => candidate >= 1)
  }
  if ('maxReviewFailures' in input) {
    patch.maxReviewFailures = parseInteger(input.maxReviewFailures, `${field}.maxReviewFailures`, meta, 'a positive integer', (candidate) => candidate >= 1)
  }
  return patch
}

export function readSettingsFileStrict(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) return {}
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf-8')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to read settings file '${filePath}': ${message}`, { cause: error })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse settings file '${filePath}': ${message}`, { cause: error })
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`Settings file '${filePath}' must contain a JSON object.`)
  }
  return parsed
}

function deepMerge<T extends Record<string, unknown>>(base: T, patch: Record<string, unknown>): T {
  const next: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const current = next[key]
    next[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value
  }
  return next as T
}

function resolvePatch(patch: WatchdogConfigPatch): ResolvedWatchdogConfig {
  const config = deepMerge(cloneDefaultConfig() as unknown as Record<string, unknown>, patch as Record<string, unknown>) as unknown as ResolvedWatchdogConfig
  config.enabled = patch.enabled ?? DEFAULT_WATCHDOG_CONFIG.enabled
  config.main.enabled = patch.main?.enabled ?? config.enabled
  return config
}

/** 把（已归一化的）插件配置面转成补丁：基层层，供文件/会话层覆盖。 */
function patchFromConfigFace(config: PluginWatchdogConfig | undefined): WatchdogConfigPatch {
  if (!config) return {}
  const patch: WatchdogConfigPatch = {}
  patch.enabled = config.enabled
  if (config.delivery !== undefined) patch.delivery = config.delivery
  if (config.showDuringRun !== undefined) patch.showDuringRun = config.showDuringRun
  if (config.syncBacklog !== undefined) patch.syncBacklog = config.syncBacklog
  if (config.agentEndTimeoutMs !== undefined) patch.agentEndTimeoutMs = config.agentEndTimeoutMs
  if (config.lateWarningPolicy !== undefined) patch.lateWarningPolicy = config.lateWarningPolicy
  if (config.severityThreshold !== undefined) patch.severityThreshold = config.severityThreshold
  if (config.maxWarnings !== undefined) patch.maxWarnings = config.maxWarnings
  if (config.guidance !== undefined) patch.guidance = config.guidance
  if (config.main && (config.main.model !== undefined || config.main.thinking !== undefined)) {
    patch.main = {
      ...(config.main.model !== undefined ? { model: config.main.model } : {}),
      ...(config.main.thinking !== undefined ? { thinking: config.main.thinking } : {}),
    }
  }
  if (config.children) {
    const children: WatchdogChildrenPatch = {}
    if (config.children.enabled !== undefined) children.enabled = config.children.enabled
    if (config.children.model !== undefined) children.model = config.children.model
    if (config.children.thinking !== undefined) children.thinking = config.children.thinking
    if (config.children.watchdogTailTimeoutMs !== undefined) children.watchdogTailTimeoutMs = config.children.watchdogTailTimeoutMs
    if (config.children.autoFollow !== undefined) children.autoFollow = config.children.autoFollow
    if (config.children.overrides && Object.keys(config.children.overrides).length > 0) children.overrides = config.children.overrides
    if (Object.keys(children).length > 0) patch.children = children
  }
  if (config.scope?.enabled !== undefined) patch.scope = { enabled: config.scope.enabled }
  if (config.cadence?.everyNTools !== undefined) patch.cadence = { everyNTools: config.cadence.everyNTools }
  if (config.autoFollow) patch.autoFollow = { ...config.autoFollow }
  if (config.asyncCompletion !== undefined) patch.asyncCompletion = config.asyncCompletion
  if (config.lsp !== undefined) patch.lsp = config.lsp
  if (config.compactAtPercent !== undefined) patch.compactAtPercent = config.compactAtPercent
  if (config.reviewRetryDelayMs !== undefined) patch.reviewRetryDelayMs = config.reviewRetryDelayMs
  if (config.maxReviewFailures !== undefined) patch.maxReviewFailures = config.maxReviewFailures
  return patch
}

function parseSourceFile(filePath: string, scope: 'user' | 'project'): WatchdogConfigPatch {
  return parseWatchdogPatch(readSettingsFileStrict(filePath), 'watchdog', { scope, path: filePath })
}

function parseSessionOverride(value: Record<string, unknown>): WatchdogConfigPatch {
  return parseWatchdogPatch(value, 'watchdog', { scope: 'session' })
}

export interface ResolveWatchdogOptions {
  session?: Record<string, unknown>
  config?: PluginWatchdogConfig
  home?: string
}

export function resolveWatchdogConfigStrict(cwd: string, options: ResolveWatchdogOptions = {}): ResolvedWatchdogConfig {
  const result = resolveWatchdogConfig(cwd, options)
  if (!result.ok) throw new Error(result.errors.map((error) => error.message).join('; '))
  return result.config
}

export function resolveWatchdogConfig(cwd: string, options: ResolveWatchdogOptions = {}): WatchdogSettingsResult {
  const home = options.home ?? process.env.HOME ?? ''
  const sources: WatchdogSettingsSource[] = []
  const errors: WatchdogSettingsError[] = []
  let patch: WatchdogConfigPatch = patchFromConfigFace(options.config)
  const userPath = getWatchdogUserSettingsPath(home)
  const projectPath = getWatchdogProjectSettingsPath(cwd)
  const sourceSpecs: Array<{ scope: 'user' | 'project'; path: string }> = [
    { scope: 'user', path: userPath },
    { scope: 'project', path: projectPath },
  ]
  for (const source of sourceSpecs) {
    sources.push({ scope: source.scope, path: source.path, exists: fs.existsSync(source.path) })
    try {
      patch = deepMerge(patch as Record<string, unknown>, parseSourceFile(source.path, source.scope) as Record<string, unknown>) as WatchdogConfigPatch
    } catch (error) {
      errors.push({ scope: source.scope, path: source.path, message: error instanceof Error ? error.message : String(error) })
    }
  }
  if (options.session) {
    sources.push({ scope: 'session', exists: true })
    try {
      patch = deepMerge(patch as Record<string, unknown>, parseSessionOverride(options.session) as Record<string, unknown>) as WatchdogConfigPatch
    } catch (error) {
      errors.push({ scope: 'session', message: error instanceof Error ? error.message : String(error) })
    }
  }
  return {
    ok: errors.length === 0,
    config: errors.length === 0 ? resolvePatch(patch) : cloneDefaultConfig(),
    errors,
    sources,
  }
}

function ensureObjectField(parent: Record<string, unknown>, key: string, field: string, meta: ParseMeta): Record<string, unknown> {
  if (!(key in parent)) parent[key] = {}
  if (!isPlainObject(parent[key])) throw invalid(meta, field, 'an object')
  return parent[key]
}

function settingsPathForWrite(scope: WatchdogSettingsWriteScope, cwd: string | undefined, home: string): string {
  return scope === 'user' ? getWatchdogUserSettingsPath(home) : getWatchdogProjectSettingsPath(cwd ?? process.cwd())
}

function targetSettingsObject(watchdog: Record<string, unknown>, target: WatchdogModelSettingsTarget, meta: ParseMeta): Record<string, unknown> {
  if (target.kind === 'main') return ensureObjectField(watchdog, 'main', 'watchdog.main', meta)
  const children = ensureObjectField(watchdog, 'children', 'watchdog.children', meta)
  if (target.kind === 'children') return children
  if (!target.agent.trim()) throw invalid(meta, 'watchdog.children.overrides.<agent>', 'a non-empty agent name')
  const overrides = ensureObjectField(children, 'overrides', 'watchdog.children.overrides', meta)
  return ensureObjectField(overrides, target.agent.trim(), `watchdog.children.overrides.${target.agent.trim()}`, meta)
}

export function writeSettingsFile(settingsPath: string, settings: Record<string, unknown>): string {
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true })
  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf-8')
  return settingsPath
}

export function writeUserWatchdogEnabled(enabled: boolean, home: string): string {
  const settingsPath = getWatchdogUserSettingsPath(home)
  const meta: ParseMeta = { scope: 'user', path: settingsPath }
  // dsh 文件面是扁平 watchdog 形状：文件根即 watchdog 对象
  const settings = readSettingsFileStrict(settingsPath)
  settings.enabled = enabled
  targetSettingsObject(settings, { kind: 'main' }, meta).enabled = enabled
  return writeSettingsFile(settingsPath, settings)
}

export function writeWatchdogModelSettings(input: WatchdogModelSettingsWrite, home: string): string {
  const settingsPath = settingsPathForWrite(input.scope, input.cwd, home)
  const meta: ParseMeta = { scope: input.scope, path: settingsPath }
  const settings = readSettingsFileStrict(settingsPath)
  const target = targetSettingsObject(settings, input.target, meta)
  if (input.model === null) delete target.model
  else if (input.model !== undefined) target.model = input.model
  if (input.thinking === null) delete target.thinking
  else if (input.thinking !== undefined) target.thinking = input.thinking
  return writeSettingsFile(settingsPath, settings)
}
