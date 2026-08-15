/**
 * Agent 命名身份：package 前缀、运行时名、别名解析（移植自 pi-subagents，MIT）。
 */

const IDENTIFIER_PATTERN = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9][a-z0-9-]*)*$/

function normalizePackageName(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (!trimmed) return undefined
  return trimmed.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9.-]/g, '').replace(/-+/g, '-').replace(/\.+/g, '.').replace(/(?:^[-.]+|[-.]+$)/g, '')
}

/** 解析并规范 `package` 字段（小写连字符；非法输入返回错误）。 */
export function parsePackageName(value: unknown, label = 'package'): { packageName?: string; error?: string } {
  if (value === undefined || value === false || value === '') return {}
  if (typeof value !== 'string') return { error: `${label} must be a string or false when provided.` }
  const packageName = normalizePackageName(value)
  if (!packageName || !IDENTIFIER_PATTERN.test(packageName)) return { error: `${label} is invalid after sanitization.` }
  return { packageName }
}

/** 组装运行时名：`package.name`（有 package 时）或裸 localName。 */
export function buildRuntimeName(localName: string, packageName?: string): string {
  const trimmedPackage = packageName?.trim()
  return trimmedPackage ? `${trimmedPackage}.${localName}` : localName
}

/** 从运行时名还原 frontmatter 的 name（去掉 package 前缀）。 */
export function frontmatterNameForConfig(config: { name: string; localName?: string; packageName?: string }): string {
  if (config.localName) return config.localName
  if (config.packageName && config.name.startsWith(`${config.packageName}.`)) {
    return config.name.slice(config.packageName.length + 1)
  }
  return config.name
}

/**
 * 解析 `aliases` 字段：逗号分隔字符串、字符串数组或 false（清空）。
 */
export function parseAliases(value: unknown): { aliases?: string[]; error?: string } {
  if (value === undefined || value === false || value === '') return {}
  const list = Array.isArray(value) ? value : String(value).split(',')
  const aliases = list
    .map((item) => String(item).trim())
    .filter(Boolean)
    .map((item) => item.toLowerCase())
  if (aliases.some((item) => !/^[a-z0-9][a-z0-9-]*$/.test(item))) {
    return { error: `aliases must be lowercase identifiers: ${aliases.join(', ')}` }
  }
  return { aliases }
}

/**
 * 解析一个 agent 目标名：规范名优先，其次别名。
 * 别名冲突（多个不同规范 agent 声明同一别名）返回 error。
 */
export function resolveAgentTarget(
  target: string,
  agents: ReadonlyArray<{ name: string; aliases?: readonly string[] }>,
): { name?: string; viaAlias?: boolean; error?: string } {
  const canonical = agents.find((agent) => agent.name === target)
  if (canonical) return { name: canonical.name }
  const lower = target.toLowerCase()
  const matches = agents.filter((agent) => agent.aliases?.includes(lower))
  if (matches.length === 0) return { error: `unknown agent "${target}"` }
  const distinct = [...new Set(matches.map((agent) => agent.name))]
  if (distinct.length > 1) {
    return { error: `alias "${target}" is ambiguous: matches ${distinct.join(', ')}` }
  }
  return { name: distinct[0], viaAlias: true }
}
