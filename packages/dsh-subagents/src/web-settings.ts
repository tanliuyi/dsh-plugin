/**
 * Web 设置页的宿主侧存储与合并逻辑。
 *
 * 设置页（浏览器端 client 插件）经本插件注册的 HTTP 路由读写
 * `~/.dsh/subagents/web-settings.json`。文件只存「覆盖」字段（扁平形状），
 * 插件加载时把覆盖合并到归一化配置之上；运行中通过 HTTP 写入的覆盖会就地
 * 修改内存中的归一化配置（live-apply），无需重启即可生效。
 *
 * 为什么不用 Host settings API：dsh 的 settings RPC 命名空间是 api-proxy 的
 * 白名单（WEB_SETTINGS_NAMESPACES），第三方插件命名空间只会得到
 * `settings-not-exposed`；因此本插件自带一条同源 HTTP 路由作为传输。
 */

import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { normalizeConfig } from './config.ts'
import type { Config } from './config.ts'
import type { SubagentsConfig } from './types.ts'
import { readJsonFile, writeJsonAtomic } from './util.ts'

/** 设置页可编辑字段的扁平形状（wire 与文件都使用它）。 */
export interface WebSettingsValue {
  /** workflowScript 缺省后台。 */
  asyncByDefault?: boolean
  /** 运行级默认时限（毫秒）。 */
  timeoutMs?: number
  /** gate 验证命令执行超时（毫秒）。 */
  gateTimeoutMs?: number
  /** 单次运行树累计子代理上限。 */
  maxSubagentSpawnsPerRun?: number
  /** 会话累计子代理启动上限；缺省 = 无限。 */
  maxSubagentSpawnsPerSession?: number
  /** 会话并发顶层后台运行上限；缺省 = 无限。 */
  maxActiveAsyncRunsPerSession?: number
  /** 嵌套委派深度上限。 */
  maxSubagentDepth?: number
  /** 默认子代理模型 id。 */
  defaultModel?: string
  /** 默认 thinking 级别；false = 关闭。 */
  defaultThinking?: string | false
  /** missions 存储开关（结构在 apply 期固定，改动需重启）。 */
  missionsEnabled?: boolean
  /** 持久调度开关（结构在 apply 期固定，改动需重启）。 */
  scheduledRunsEnabled?: boolean
  /** intercom bridge 模式。 */
  intercomMode?: 'always' | 'fork-only' | 'off'
  /** watchdog 开关。 */
  watchdogEnabled?: boolean
  /** watchdog 主评审模型。 */
  watchdogMainModel?: string
  /** watchdog 主评审 thinking 级别。 */
  watchdogMainThinking?: string | false
}

/** 覆盖文件的磁盘形状（与 {@link WebSettingsValue} 同构，只含被覆盖的键）。 */
export type WebSettingsOverrides = WebSettingsValue

/** 相对 `~/.dsh` 的覆盖文件路径。 */
export const WEB_SETTINGS_FILE = path.join('subagents', 'web-settings.json')

/** 覆盖文件绝对路径（与 user overrides.json 同一目录）。 */
export function webSettingsFile(home: string): string {
  return path.join(home, '.dsh', WEB_SETTINGS_FILE)
}

/** 改动后需要重启才生效的键（对应 apply 期固定结构的子系统）。 */
export const RESTART_REQUIRED_KEYS: ReadonlySet<keyof WebSettingsValue> = new Set([
  'missionsEnabled',
  'scheduledRunsEnabled',
])

/** 同步读取覆盖（apply 期用；文件缺失或损坏返回空覆盖）。 */
export function loadWebSettingsSync(home: string): WebSettingsOverrides {
  try {
    const parsed: unknown = JSON.parse(readFileSync(webSettingsFile(home), 'utf8'))
    const result = sanitizeWebValues(parsed)
    return result.ok ? result.value : {}
  } catch {
    return {}
  }
}

/** 异步读取覆盖（路由用），缺失或损坏返回空覆盖。 */
export async function loadWebSettings(home: string): Promise<WebSettingsOverrides> {
  const parsed = await readJsonFile<unknown>(webSettingsFile(home))
  if (parsed === undefined) return {}
  const result = sanitizeWebValues(parsed)
  return result.ok ? result.value : {}
}

/** 原子写入覆盖文件。 */
export async function saveWebSettings(home: string, overrides: WebSettingsOverrides): Promise<void> {
  await writeJsonAtomic(webSettingsFile(home), overrides)
}

/** 单次提交允许的最大键数（设置页可见键共 15 个，上限留足余量防滥用）。 */
export const MAX_SETTING_KEYS = 64

/** 校验并规范来自 wire/文件的未知值；非法时给出逐键错误。null/undefined 一律忽略。 */
export function sanitizeWebValues(raw: unknown): { ok: true; value: WebSettingsValue } | { ok: false; errors: string[] } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ['设置值必须是对象'] }
  }
  const errors: string[] = []
  const out: WebSettingsValue = {}
  const record = raw as Record<string, unknown>
  if (Object.keys(record).length > MAX_SETTING_KEYS) {
    return { ok: false, errors: [`设置键数量超过上限 ${MAX_SETTING_KEYS}`] }
  }
  for (const [key, value] of Object.entries(record)) {
    if (value === undefined || value === null) continue
    switch (key) {
      case 'asyncByDefault':
      case 'missionsEnabled':
      case 'scheduledRunsEnabled':
      case 'watchdogEnabled':
        if (typeof value === 'boolean') out[key] = value
        else errors.push(`${key} 必须是布尔值`)
        break
      case 'timeoutMs':
      case 'gateTimeoutMs':
      case 'maxSubagentSpawnsPerRun':
      case 'maxSubagentSpawnsPerSession':
      case 'maxActiveAsyncRunsPerSession':
      case 'maxSubagentDepth':
        if (typeof value === 'number' && Number.isInteger(value) && value >= 0) out[key] = value
        else errors.push(`${key} 必须是非负整数`)
        break
      case 'defaultModel':
      case 'watchdogMainModel':
        if (typeof value === 'string' && value.length > 0) out[key] = value
        else errors.push(`${key} 必须是非空字符串`)
        break
      case 'defaultThinking':
      case 'watchdogMainThinking':
        if (value === false) out[key] = false
        else if (typeof value === 'string' && value.length > 0) out[key] = value
        else errors.push(`${key} 必须是字符串或 false`)
        break
      case 'intercomMode':
        if (value === 'always' || value === 'fork-only' || value === 'off') out[key] = value
        else errors.push('intercomMode 必须是 always/fork-only/off')
        break
      default:
        errors.push(`未知设置键：${key}`)
        break
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: out }
}

/** 设置页可见的全部键（applyWebValues 的复位面）。 */
export const ALL_WEB_KEYS: (keyof WebSettingsValue)[] = [
  'asyncByDefault', 'timeoutMs', 'gateTimeoutMs',
  'maxSubagentSpawnsPerRun', 'maxSubagentSpawnsPerSession', 'maxActiveAsyncRunsPerSession',
  'maxSubagentDepth', 'defaultModel', 'defaultThinking',
  'missionsEnabled', 'scheduledRunsEnabled', 'intercomMode',
  'watchdogEnabled', 'watchdogMainModel', 'watchdogMainThinking',
]

/** 写单个扁平键到归一化配置（就地；value 可为 undefined = 复位）。 */
function setWebKey(normalized: SubagentsConfig, key: keyof WebSettingsValue, value: WebSettingsValue[keyof WebSettingsValue]): void {
  const target = normalized as unknown as Record<string, unknown>
  switch (key) {
    case 'asyncByDefault':
    case 'timeoutMs':
    case 'gateTimeoutMs':
    case 'maxSubagentSpawnsPerRun':
    case 'maxSubagentSpawnsPerSession':
    case 'maxActiveAsyncRunsPerSession':
    case 'maxSubagentDepth':
    case 'defaultModel':
    case 'defaultThinking':
      target[key] = value
      break
    case 'missionsEnabled':
      target.missions = { ...normalized.missions, enabled: value as boolean }
      break
    case 'scheduledRunsEnabled':
      target.scheduledRuns = { ...normalized.scheduledRuns, enabled: value as boolean }
      break
    case 'intercomMode':
      target.intercomBridge = { ...normalized.intercomBridge, mode: value as 'always' | 'fork-only' | 'off' }
      break
    case 'watchdogEnabled':
      target.watchdog = { ...normalized.watchdog, enabled: value as boolean }
      break
    case 'watchdogMainModel':
    case 'watchdogMainThinking':
      target.watchdog = { ...normalized.watchdog, main: { ...normalized.watchdog.main, [key === 'watchdogMainModel' ? 'model' : 'thinking']: value } }
      break
  }
}

/**
 * 把「完整扁平值」应用到归一化配置（就地修改，live-apply）。
 * 与 {@link applyWebOverrides} 不同：显式 undefined 也会写入（用于复位）。
 */
export function applyWebValues(normalized: SubagentsConfig, values: WebSettingsValue): void {
  for (const key of ALL_WEB_KEYS) {
    setWebKey(normalized, key, values[key])
  }
}

/** 把「覆盖」合并到归一化配置（就地；只写显式提供的键，其余键不被触碰）。 */
export function applyWebOverrides(normalized: SubagentsConfig, overrides: WebSettingsOverrides): void {
  for (const [key, value] of Object.entries(overrides) as [keyof WebSettingsOverrides, WebSettingsValue[keyof WebSettingsValue]][]) {
    if (value === undefined) continue
    setWebKey(normalized, key, value)
  }
}

/** 从归一化配置提取设置页可见的扁平值（baseline 或 effective）。 */
export function extractWebValues(config: SubagentsConfig): WebSettingsValue {
  return {
    asyncByDefault: config.asyncByDefault,
    timeoutMs: config.timeoutMs,
    gateTimeoutMs: config.gateTimeoutMs,
    maxSubagentSpawnsPerRun: config.maxSubagentSpawnsPerRun,
    maxSubagentSpawnsPerSession: config.maxSubagentSpawnsPerSession,
    maxActiveAsyncRunsPerSession: config.maxActiveAsyncRunsPerSession,
    maxSubagentDepth: config.maxSubagentDepth,
    defaultModel: config.defaultModel,
    defaultThinking: config.defaultThinking,
    missionsEnabled: config.missions.enabled,
    scheduledRunsEnabled: config.scheduledRuns.enabled,
    intercomMode: config.intercomBridge.mode,
    watchdogEnabled: config.watchdog.enabled,
    watchdogMainModel: config.watchdog.main.model,
    watchdogMainThinking: config.watchdog.main.thinking,
  }
}

/**
 * 计算「effective 相对 baseline」的覆盖：只保留两者不同的键。
 * baseline 与 effective 都来自归一化配置（默认值已填充），因此可直接按值比较；
 * effective 为 undefined 的键（= 未设置）不落盘。
 */
export function computeOverrides(baseline: WebSettingsValue, effective: WebSettingsValue): WebSettingsOverrides {
  const out: Record<string, unknown> = {}
  for (const [key, b] of Object.entries(effective) as [keyof WebSettingsValue, WebSettingsValue[keyof WebSettingsValue]][]) {
    if (b !== undefined && b !== baseline[key]) out[key] = b
  }
  return out as WebSettingsOverrides
}

/** 覆盖键分类：live 生效 vs 需重启。 */
export function classifyOverrides(overrides: WebSettingsOverrides): { applied: string[]; restartRequired: string[] } {
  const applied: string[] = []
  const restartRequired: string[] = []
  for (const key of Object.keys(overrides)) {
    if (RESTART_REQUIRED_KEYS.has(key as keyof WebSettingsValue)) restartRequired.push(key)
    else applied.push(key)
  }
  return { applied, restartRequired }
}

/** 构造最终运行时配置：cordis 配置 + 覆盖（供 apply 使用）。 */
export function buildEffectiveConfig(config: Config, overrides: WebSettingsOverrides): SubagentsConfig {
  const normalized = normalizeConfig(config)
  applyWebOverrides(normalized, overrides)
  return normalized
}
