/**
 * Capability ceiling（对齐上游 pi-subagents src/runs/shared/capability-ceiling.ts）。
 *
 * 语义：会话级注册的能力上限（allowedTools / allowedAgents / denyExtensions），
 * spawn 时交集过滤——受限工具被移除、受限 agent 被拒绝。上游由宿主 API 注册；
 * dsh 无宿主概念，注册表语义保留，dsh 侧通过 config.capabilityCeiling 提供静态
 * 上限（intersect 仍支持多源合并）。
 */

export const SUBAGENT_CAPABILITY_CEILING_VERSION = 1 as const

export type SubagentCapabilityCeiling =
  | { allowedTools: readonly string[]; allowedAgents?: readonly string[]; denyExtensions?: boolean }
  | { allowedTools?: readonly string[]; allowedAgents?: readonly string[]; denyExtensions: boolean }
  | { allowedTools?: readonly string[]; allowedAgents: readonly string[]; denyExtensions?: boolean }

export interface ResolvedSubagentCapabilityCeiling {
  version: typeof SUBAGENT_CAPABILITY_CEILING_VERSION
  allowedTools?: string[]
  allowedAgents?: string[]
  denyExtensions: boolean
  sources: string[]
}

const NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/u

function validateText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim() || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value.trim(), 'utf8') > 256) {
    throw new Error(`Invalid capability ceiling ${field}; expected a non-empty string without control characters (max 256 UTF-8 bytes).`)
  }
  return value.trim()
}

function normalizeList(field: 'allowedTools' | 'allowedAgents', ceiling: Record<string, unknown>): string[] | undefined {
  if (!Object.hasOwn(ceiling, field)) return undefined
  const values = ceiling[field]
  if (!Array.isArray(values)) throw new Error(`Invalid capability ceiling ${field}; expected an array.`)
  if (values.length > 256) throw new Error(`Invalid capability ceiling ${field}; expected at most 256 names.`)
  return [...new Set(values.map((entry) => {
    const name = validateText(entry, `${field} entry`)
    if (!NAME_PATTERN.test(name)) throw new Error(`Invalid capability ceiling ${field} entry '${name}'.`)
    if (Buffer.byteLength(name, 'utf8') > 128) throw new Error(`Invalid capability ceiling ${field} entry '${name}'; max 128 UTF-8 bytes.`)
    return name
  }))].sort()
}

/** 规范化一个 ceiling（校验形状与名称）。 */
export function normalizeCeiling(ceiling: SubagentCapabilityCeiling): ResolvedSubagentCapabilityCeiling {
  if (!ceiling || typeof ceiling !== 'object' || Array.isArray(ceiling)) throw new Error('Invalid capability ceiling; expected an object.')
  const record = ceiling as Record<string, unknown>
  const hasAllowedTools = Object.hasOwn(record, 'allowedTools')
  const hasAllowedAgents = Object.hasOwn(record, 'allowedAgents')
  const hasDenyExtensions = Object.hasOwn(record, 'denyExtensions')
  if (!hasAllowedTools && !hasAllowedAgents && !hasDenyExtensions) {
    throw new Error('Invalid capability ceiling; expected allowedTools, allowedAgents, or denyExtensions.')
  }
  if (hasDenyExtensions && typeof record.denyExtensions !== 'boolean') throw new Error('Invalid capability ceiling denyExtensions; expected a boolean.')
  const allowedTools = normalizeList('allowedTools', record)
  const allowedAgents = normalizeList('allowedAgents', record)
  return {
    version: SUBAGENT_CAPABILITY_CEILING_VERSION,
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(allowedAgents !== undefined ? { allowedAgents } : {}),
    denyExtensions: record.denyExtensions === true,
    sources: [],
  }
}

/** 多个 ceiling 求交集（对齐上游 intersectSubagentCapabilityCeilings）。 */
export function intersectSubagentCapabilityCeilings(...ceilings: Array<ResolvedSubagentCapabilityCeiling | undefined>): ResolvedSubagentCapabilityCeiling | undefined {
  const active = ceilings.filter((ceiling): ceiling is ResolvedSubagentCapabilityCeiling => ceiling !== undefined)
  if (active.length === 0) return undefined
  const intersectLists = (field: 'allowedTools' | 'allowedAgents'): string[] | undefined => {
    const definedLists = active.filter((ceiling) => ceiling[field] !== undefined).map((ceiling) => new Set(ceiling[field]))
    if (definedLists.length === 0) return undefined
    return [...definedLists[0]!].filter((entry) => definedLists.every((list) => list.has(entry))).sort()
  }
  const allowedTools = intersectLists('allowedTools')
  const allowedAgents = intersectLists('allowedAgents')
  return {
    version: SUBAGENT_CAPABILITY_CEILING_VERSION,
    ...(allowedTools !== undefined ? { allowedTools } : {}),
    ...(allowedAgents !== undefined ? { allowedAgents } : {}),
    denyExtensions: active.some((ceiling) => ceiling.denyExtensions),
    sources: [...new Set(active.flatMap((ceiling) => ceiling.sources))].sort(),
  }
}

/** agent 是否被上限允许（无 allowedAgents 即允许）。 */
export function isAgentAllowedByCapabilityCeiling(agentName: string, ceiling: ResolvedSubagentCapabilityCeiling | undefined): boolean {
  return ceiling?.allowedAgents === undefined || ceiling.allowedAgents.includes(agentName)
}

/** agent 被拒时的诊断消息（对齐上游文案）。 */
export function capabilityCeilingAgentRestrictionMessage(agentName: string, ceiling: ResolvedSubagentCapabilityCeiling | undefined): string | undefined {
  if (isAgentAllowedByCapabilityCeiling(agentName, ceiling)) return undefined
  const sources = ceiling?.sources?.length ? ceiling.sources.join(', ') : 'unknown source'
  const allowed = ceiling?.allowedAgents?.length ? ceiling.allowedAgents.join(', ') : '(none)'
  return `Capability ceiling from ${sources} does not allow agent '${agentName}'. Allowed agents: ${allowed}.`
}

/** 工具是否被上限允许：allowedTools 不存在则允许（对齐上游 toolPlan 过滤语义）。 */
export function isToolAllowedByCapabilityCeiling(toolName: string, ceiling: ResolvedSubagentCapabilityCeiling | undefined): boolean {
  return ceiling?.allowedTools === undefined || ceiling.allowedTools.includes(toolName)
}
