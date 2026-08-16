/**
 * Agent 发现与解析：builtin（包内 agents/）、user（~/.dsh/subagents/agents）、
 * project（<root>/.dsh/subagents/agents），优先级 project > user > builtin。
 * 覆盖来源：插件配置 agentOverrides + 每作用域 overrides.json。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { AgentConfig, AgentOverride, AgentScope, SubagentsConfig } from '../types.ts'
import { PROJECT_AGENT_DIR, PROJECT_DATA_DIR, USER_AGENT_DIR } from '../types.ts'
import { parseFrontmatter, parseFrontmatterList, parseBool, parsePositiveInt, parseJsonField, optionalString } from './frontmatter.ts'
import { buildRuntimeName, parsePackageName } from './identity.ts'
import { readJsonFile, resolvePath } from '../util.ts'

/** 包内 builtin agents 目录。 */
export function builtinAgentsDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'agents')
}

/** user agents 目录：~/.dsh/subagents/agents。 */
export function userAgentsDir(home = process.env.HOME ?? ''): string {
  return path.join(home, '.dsh', USER_AGENT_DIR)
}

/** user 作用域 overrides.json 路径。 */
export function userOverridesFile(home = process.env.HOME ?? ''): string {
  return path.join(home, '.dsh', PROJECT_DATA_DIR, 'overrides.json')
}

/** project 作用域 overrides.json 路径。 */
export function projectOverridesFile(projectRoot: string): string {
  return path.join(projectRoot, '.dsh', PROJECT_DATA_DIR, 'overrides.json')
}

function parseBoolish(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined
  return value === 'true' || value === '1'
}

/** 从 frontmatter 记录构造 AgentConfig（缺省 body）。 */
export function agentConfigFromFrontmatter(
  frontmatter: Record<string, string>,
  body: string,
  source: { file?: string; scope: 'builtin' | 'user' | 'project' },
): AgentConfig | undefined {
  const rawName = frontmatter['name']
  if (!rawName || rawName.trim() === '') return undefined
  const localName = rawName.trim()
  const { packageName } = parsePackageName(frontmatter['package'])
  const aliases = parseFrontmatterList(frontmatter['aliases']) ?? parseFrontmatterList(frontmatter['alias'])
  const aliasesNormalized = aliases?.map((a) => a.toLowerCase())
  const acceptanceRaw = parseJsonField(frontmatter['acceptance'])
  const turnBudgetRaw = parseJsonField(frontmatter['turnBudget'])
  const memoryRaw = parseJsonField(frontmatter['memory'])
  const tools = parseFrontmatterList(frontmatter['tools'])
  const model = optionalString(frontmatter['model'])
  const thinkingRaw = frontmatter['thinking']
  // 'off' 与 'false' 都表示关闭思考（对齐上游 serializer 对 'off' 的专门处理）
  const thinking = thinkingRaw === 'false' || thinkingRaw === 'off' ? false : optionalString(thinkingRaw)
  return {
    name: buildRuntimeName(localName, packageName),
    localName,
    packageName,
    description: optionalString(frontmatter['description']) ?? '',
    aliases: aliasesNormalized,
    tools,
    extensions: parseFrontmatterList(frontmatter['extensions']),
    model,
    fallbackModels: parseFrontmatterList(frontmatter['fallbackModels']),
    thinking,
    systemPromptMode: frontmatter['systemPromptMode'] === 'append' ? 'append' : frontmatter['systemPromptMode'] === 'replace' ? 'replace' : undefined,
    inheritProjectContext: parseBoolish(frontmatter['inheritProjectContext']),
    inheritSkills: parseBoolish(frontmatter['inheritSkills']),
    skills: parseFrontmatterList(frontmatter['skills']),
    skillPath: parseFrontmatterList(frontmatter['skillPath']),
    output: frontmatter['output'] === 'false' || frontmatter['output'] === '' ? false : optionalString(frontmatter['output']),
    defaultReads: parseFrontmatterList(frontmatter['defaultReads']),
    defaultProgress: parseBool(frontmatter['defaultProgress'], false),
    defaultContext: frontmatter['defaultContext'] === 'fork' ? 'fork' : frontmatter['defaultContext'] === 'fresh' ? 'fresh' : undefined,
    async: parseBoolish(frontmatter['async']),
    timeoutMs: parsePositiveInt(frontmatter['timeoutMs']),
    toolTimeoutMs: parsePositiveInt(frontmatter['toolTimeoutMs']),
    turnBudget: turnBudgetRaw && typeof turnBudgetRaw['maxTurns'] === 'number' ? { maxTurns: turnBudgetRaw['maxTurns'], graceTurns: typeof turnBudgetRaw['graceTurns'] === 'number' ? turnBudgetRaw['graceTurns'] : undefined } : undefined,
    acceptance: acceptanceRaw as AgentConfig['acceptance'],
    acceptanceRole: frontmatter['acceptanceRole'] === 'read-only' ? 'read-only' : frontmatter['acceptanceRole'] === 'writer' ? 'writer' : undefined,
    completionGuard: parseBoolish(frontmatter['completionGuard']),
    maxSubagentDepth: parsePositiveInt(frontmatter['maxSubagentDepth']),
    disabled: parseBoolish(frontmatter['disabled']),
    memory: memoryRaw && (memoryRaw['scope'] === 'project' || memoryRaw['scope'] === 'user') && typeof memoryRaw['path'] === 'string'
      ? { scope: memoryRaw['scope'], path: memoryRaw['path'] }
      : undefined,
    systemPrompt: body,
    file: source.file,
    scope: source.scope,
  }
}

async function readAgentFile(filePath: string, scope: 'builtin' | 'user' | 'project'): Promise<AgentConfig | undefined> {
  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch {
    return undefined
  }
  const { frontmatter, body } = parseFrontmatter(content)
  const config = agentConfigFromFrontmatter(frontmatter, body, { file: filePath, scope })
  if (!config) return undefined
  return config
}

async function listAgentFiles(dir: string): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(dir, { recursive: true })
  } catch {
    return []
  }
  const files: string[] = []
  for (const entry of entries) {
    if (typeof entry !== 'string') continue
    if (!entry.endsWith('.md') || entry.endsWith('.chain.md')) continue
    const full = path.join(dir, entry)
    try {
      const info = await stat(full)
      if (info.isFile()) files.push(full)
    } catch {
      // 忽略
    }
  }
  return files
}

/** 一次发现：返回按 name 去重（后者覆盖前者）的映射。 */
export async function discoverAgentDir(dir: string, scope: 'builtin' | 'user' | 'project'): Promise<Map<string, AgentConfig>> {
  const out = new Map<string, AgentConfig>()
  for (const file of await listAgentFiles(dir)) {
    const config = await readAgentFile(file, scope)
    if (config) out.set(config.name, config)
  }
  return out
}

/** 运行时作用域覆盖（overrides.json，disable/enable 等管理动作写入）。 */
export interface ScopeOverrides {
  agents: Record<string, AgentOverride>
}

/** Agent 注册表：合并三层发现结果与覆盖。 */
export class AgentRegistry {
  private builtin?: Map<string, AgentConfig>
  private user?: Map<string, AgentConfig>
  private projectCache = new Map<string, { agents: Map<string, AgentConfig>; overrides: Record<string, AgentOverride> }>()
  private userOverrides: Record<string, AgentOverride> = {}

  constructor(
    private readonly config: SubagentsConfig,
    private readonly home = process.env.HOME ?? '',
  ) {}

  /** 重新发现 builtin/user 目录与 user overrides（project 层按需懒加载）。 */
  async refresh(): Promise<void> {
    const [builtin, user, userOverrides] = await Promise.all([
      discoverAgentDir(builtinAgentsDir(), 'builtin'),
      discoverAgentDir(userAgentsDir(this.home), 'user'),
      readJsonFile<ScopeOverrides>(userOverridesFile(this.home)),
    ])
    this.builtin = builtin
    this.user = user
    this.userOverrides = userOverrides?.agents ?? {}
  }

  private async projectData(projectRoot: string): Promise<{ agents: Map<string, AgentConfig>; overrides: Record<string, AgentOverride> }> {
    const cached = this.projectCache.get(projectRoot)
    if (cached) return cached
    const [agents, overrides] = await Promise.all([
      discoverAgentDir(path.join(projectRoot, '.dsh', PROJECT_AGENT_DIR), 'project'),
      readJsonFile<ScopeOverrides>(projectOverridesFile(projectRoot)),
    ])
    const data = { agents, overrides: overrides?.agents ?? {} }
    this.projectCache.set(projectRoot, data)
    return data
  }

  /** 使 project 层缓存失效（create/update/delete/overrides 写操作后调用）。 */
  invalidate(projectRoot: string): void {
    this.projectCache.delete(projectRoot)
  }

  /** 合并后按优先级解析（project > user > builtin），应用配置与文件覆盖。 */
  async list(scope: AgentScope = 'both', projectRoot?: string, includeDisabled = false): Promise<AgentConfig[]> {
    await this.refresh()
    const merged = new Map<string, AgentConfig>()
    const add = (map: Map<string, AgentConfig> | undefined): void => {
      if (!map) return
      for (const [name, config] of map) merged.set(name, config)
    }
    const project = projectRoot ? await this.projectData(projectRoot) : undefined
    if (this.config.disableBuiltins) {
      if (project) add(project.agents)
    } else {
      add(this.builtin)
      if (scope === 'user' || scope === 'both') add(this.user)
      if ((scope === 'project' || scope === 'both') && project) add(project.agents)
    }
    const out: AgentConfig[] = []
    for (const [name, config] of merged) {
      if (!includeDisabled && config.disabled) continue
      const override = project?.overrides[name] ?? this.userOverrides[name] ?? this.config.agentOverrides?.[name]
      const applied = override ? applyOverride(config, override) : config
      if (!includeDisabled && applied.disabled) continue
      out.push(applied)
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  }

  /** 解析一个 agent 目标（规范名或别名）。includeDisabled 用于 enable 等需要定位已禁用 agent 的管理动作。 */
  async resolve(target: string, scope: AgentScope = 'both', projectRoot?: string, includeDisabled = false): Promise<{ agent?: AgentConfig; viaAlias?: boolean; error?: string }> {
    const agents = await this.list(scope, projectRoot, includeDisabled)
    const canonical = agents.find((agent) => agent.name === target)
    if (canonical) return { agent: canonical }
    const lower = target.toLowerCase()
    const matches = agents.filter((agent) => agent.aliases?.includes(lower))
    if (matches.length === 0) return { error: `unknown agent "${target}"` }
    const distinct = [...new Set(matches.map((agent) => agent.name))]
    if (distinct.length > 1) return { error: `alias "${target}" is ambiguous: matches ${distinct.join(', ')}` }
    return { agent: matches.find((agent) => agent.name === distinct[0]), viaAlias: true }
  }
}

/** 应用一个覆盖（未设置的字段保留原值）。 */
export function applyOverride(config: AgentConfig, override: AgentOverride): AgentConfig {
  return {
    ...config,
    description: override.description !== undefined ? override.description : config.description,
    model: override.model !== undefined ? override.model : config.model,
    fallbackModels: override.fallbackModels !== undefined ? override.fallbackModels : config.fallbackModels,
    thinking: override.thinking !== undefined ? override.thinking : config.thinking,
    systemPromptMode: override.systemPromptMode !== undefined ? override.systemPromptMode : config.systemPromptMode,
    inheritProjectContext: override.inheritProjectContext !== undefined ? override.inheritProjectContext : config.inheritProjectContext,
    inheritSkills: override.inheritSkills !== undefined ? override.inheritSkills : config.inheritSkills,
    defaultContext: override.defaultContext !== undefined ? override.defaultContext : config.defaultContext,
    acceptanceRole: override.acceptanceRole !== undefined && override.acceptanceRole !== false ? override.acceptanceRole : override.acceptanceRole === false ? undefined : config.acceptanceRole,
    disabled: override.disabled !== undefined ? override.disabled : config.disabled,
    skills: override.skills !== undefined && override.skills !== false ? override.skills : override.skills === false ? undefined : config.skills,
    tools: override.tools !== undefined && override.tools !== 'inherit' && override.tools !== false ? override.tools : override.tools === 'inherit' || override.tools === false ? undefined : config.tools,
    systemPrompt: override.systemPrompt !== undefined ? override.systemPrompt : config.systemPrompt,
  }
}

/** 作用域数据目录（user / project）。 */
export function scopeDataDir(scope: 'user' | 'project', projectRoot: string | undefined, home = process.env.HOME ?? ''): string {
  return scope === 'user' ? path.join(home, '.dsh', PROJECT_DATA_DIR) : path.join(projectRoot ?? resolvePath('.'), '.dsh', PROJECT_DATA_DIR)
}

export { resolvePath }
