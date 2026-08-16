/**
 * Agent 管理动作：list/get/create/update/delete/eject/disable/enable/reset
 * 与 refine 精炼覆盖层。文件写入 user/project 作用域，disable/enable 写
 * 作用域 overrides.json（与 pi-subagents 的 settings 覆盖对应）。
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { AgentConfig, AgentScope } from '../types.ts'
import { PROJECT_DATA_DIR } from '../types.ts'
import { serializeAgentFile, parseFrontmatter } from './frontmatter.ts'
import { buildRuntimeName, frontmatterNameForConfig, parseAliases, parsePackageName } from './identity.ts'
import { projectOverridesFile, scopeDataDir, userOverridesFile, type ScopeOverrides } from './registry.ts'
import { readJsonFile, readTextFile, writeJsonAtomic, writeTextAtomic } from '../util.ts'

/** 管理动作的作用域目标（目录 + overrides 文件）。 */
export interface ManagementTarget {
  scope: 'user' | 'project'
  dir: string
  overridesFile: string
}

/** 解析管理动作的作用域目标（user/project）。 */
export function resolveManagementTarget(scope: 'user' | 'project', projectRoot: string, home: string): ManagementTarget {
  const base = scopeDataDir(scope, projectRoot, home)
  return {
    scope,
    dir: path.join(base, 'agents'),
    overridesFile: scope === 'user' ? userOverridesFile(home) : projectOverridesFile(projectRoot),
  }
}

/** 读取作用域 overrides。 */
async function readOverrides(target: ManagementTarget): Promise<ScopeOverrides> {
  return (await readJsonFile<ScopeOverrides>(target.overridesFile)) ?? { agents: {} }
}

async function writeOverrides(target: ManagementTarget, overrides: ScopeOverrides): Promise<void> {
  await writeJsonAtomic(target.overridesFile, overrides)
}

/** 列出作用域内的自定义 agent 文件。 */
export async function listScopeAgentFiles(target: ManagementTarget): Promise<AgentConfig[]> {
  const out: AgentConfig[] = []
  let entries: string[]
  try {
    entries = await readdir(target.dir, { recursive: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.endsWith('.md') || entry.endsWith('.chain.md')) continue
    const filePath = path.join(target.dir, entry)
    const content = await readTextFile(filePath)
    if (!content) continue
    const { frontmatter, body } = parseFrontmatter(content)
    const rawName = frontmatter['name']
    if (!rawName) continue
    const { packageName } = parsePackageName(frontmatter['package'])
    const { aliases } = parseAliases(frontmatter['aliases'])
    out.push({
      name: buildRuntimeName(rawName.trim(), packageName),
      localName: rawName.trim(),
      packageName,
      aliases,
      description: frontmatter['description'] ?? '',
      systemPrompt: body,
      file: filePath,
      scope: target.scope,
    })
  }
  return out
}

/** 从管理 config 构造 AgentConfig 字段（create/update 共用）。 */
export function agentConfigFromManagementConfig(
  config: Record<string, unknown>,
  existing: AgentConfig | undefined,
): { config: AgentConfig; error?: string } {
  const localName = typeof config['name'] === 'string' && config['name'].trim() ? config['name'].trim() : existing?.localName
  if (!localName) return { config: undefined as never, error: 'config.name is required for create' }
  const { packageName, error: packageError } = parsePackageName(config['package'] === undefined ? existing?.packageName : config['package'])
  if (packageError) return { config: undefined as never, error: packageError }
  const { aliases, error: aliasError } = parseAliases(config['aliases'] === undefined ? existing?.aliases?.join(', ') : config['aliases'])
  if (aliasError) return { config: undefined as never, error: aliasError }

  const str = (key: string): string | undefined => {
    const value = config[key]
    if (value === undefined || value === false || value === '') return undefined
    return String(value)
  }
  const strList = (key: string): string[] | undefined => {
    const value = config[key]
    if (value === undefined || value === false) return undefined
    if (Array.isArray(value)) return value.map(String)
    if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean)
    return undefined
  }
  const bool = (key: string): boolean | undefined => {
    const value = config[key]
    if (value === undefined) return undefined
    return value === true || value === 'true'
  }

  const tools = strList('tools')
  const configOut: AgentConfig = {
    name: buildRuntimeName(localName, packageName),
    localName,
    packageName,
    description: str('description') ?? existing?.description ?? '',
    aliases,
    // update 省略 tools/extensions 时保留原值：静默清空会放大为"继承全部工具"
    tools: tools ?? existing?.tools,
    extensions: strList('extensions') ?? existing?.extensions,
    model: str('model') ?? existing?.model,
    fallbackModels: strList('fallbackModels') ?? existing?.fallbackModels,
    thinking: config['thinking'] === false ? false : (str('thinking') as AgentConfig['thinking']) ?? existing?.thinking,
    systemPromptMode: str('systemPromptMode') as AgentConfig['systemPromptMode'] | undefined ?? existing?.systemPromptMode,
    inheritProjectContext: bool('inheritProjectContext') ?? existing?.inheritProjectContext,
    inheritSkills: bool('inheritSkills') ?? existing?.inheritSkills,
    skills: strList('skills') ?? existing?.skills,
    defaultContext: str('defaultContext') as 'fresh' | 'fork' | undefined ?? existing?.defaultContext,
    acceptanceRole: str('acceptanceRole') as 'read-only' | 'writer' | undefined ?? existing?.acceptanceRole,
    output: config['output'] === false ? false : (str('output') as string | false | undefined) ?? existing?.output,
    defaultReads: strList('reads') ?? strList('defaultReads') ?? existing?.defaultReads,
    defaultProgress: bool('progress') ?? bool('defaultProgress') ?? existing?.defaultProgress,
    timeoutMs: typeof config['timeoutMs'] === 'number' ? config['timeoutMs'] : existing?.timeoutMs,
    turnBudget: config['turnBudget'] as AgentConfig['turnBudget'] | undefined ?? existing?.turnBudget,
    acceptance: config['acceptance'] as AgentConfig['acceptance'] | undefined ?? existing?.acceptance,
    completionGuard: bool('completionGuard') ?? existing?.completionGuard,
    maxSubagentDepth: typeof config['maxSubagentDepth'] === 'number' ? config['maxSubagentDepth'] : existing?.maxSubagentDepth,
    disabled: bool('disabled') ?? existing?.disabled,
    systemPrompt: str('systemPrompt') ?? existing?.systemPrompt ?? '',
    file: existing?.file,
    scope: existing?.scope ?? 'user',
  }
  return { config: configOut }
}

/** 把 AgentConfig 写为 markdown 文件。 */
export function serializeAgent(config: AgentConfig): string {
  const frontmatter: Record<string, unknown> = {
    name: config.localName,
  }
  if (config.packageName) frontmatter['package'] = config.packageName
  if (config.description) frontmatter['description'] = config.description
  if (config.aliases?.length) frontmatter['aliases'] = config.aliases
  if (config.tools?.length) frontmatter['tools'] = config.tools
  if (config.model) frontmatter['model'] = config.model
  if (config.fallbackModels?.length) frontmatter['fallbackModels'] = config.fallbackModels
  if (config.thinking !== undefined) frontmatter['thinking'] = config.thinking
  if (config.systemPromptMode) frontmatter['systemPromptMode'] = config.systemPromptMode
  if (config.inheritProjectContext !== undefined) frontmatter['inheritProjectContext'] = config.inheritProjectContext
  if (config.inheritSkills !== undefined) frontmatter['inheritSkills'] = config.inheritSkills
  if (config.skills?.length) frontmatter['skills'] = config.skills
  if (config.defaultContext) frontmatter['defaultContext'] = config.defaultContext
  if (config.acceptanceRole) frontmatter['acceptanceRole'] = config.acceptanceRole
  if (config.output !== undefined) frontmatter['output'] = config.output
  if (config.defaultReads?.length) frontmatter['defaultReads'] = config.defaultReads
  if (config.defaultProgress) frontmatter['defaultProgress'] = true
  if (config.timeoutMs) frontmatter['timeoutMs'] = config.timeoutMs
  if (config.turnBudget) frontmatter['turnBudget'] = JSON.stringify(config.turnBudget)
  if (config.acceptance) frontmatter['acceptance'] = JSON.stringify(config.acceptance)
  if (config.maxSubagentDepth) frontmatter['maxSubagentDepth'] = config.maxSubagentDepth
  if (config.disabled) frontmatter['disabled'] = true
  return serializeAgentFile(frontmatter, config.systemPrompt)
}

/** 在作用域目录写 agent 文件，返回路径。 */
export async function writeAgentFile(target: ManagementTarget, config: AgentConfig): Promise<string> {
  await mkdir(target.dir, { recursive: true })
  const filePath = path.join(target.dir, `${config.localName}.md`)
  await writeFile(filePath, serializeAgent(config), 'utf8')
  return filePath
}

/** disable / enable：写作用域 overrides.json。 */
export async function setAgentDisabled(target: ManagementTarget, agentName: string, disabled: boolean): Promise<string> {
  const overrides = await readOverrides(target)
  const entry = overrides.agents[agentName] ?? {}
  if (disabled) {
    entry.disabled = true
    overrides.agents[agentName] = entry
  } else {
    delete entry.disabled
    // enable 后条目为空时整个移除，避免残留空对象占位
    if (Object.keys(entry).length === 0) delete overrides.agents[agentName]
    else overrides.agents[agentName] = entry
  }
  await writeOverrides(target, overrides)
  return disabled ? `disabled agent ${agentName} in ${target.scope} scope` : `enabled agent ${agentName} in ${target.scope} scope`
}

/** eject：把内置/包 agent 复制到目标作用域为可编辑文件。 */
export async function ejectAgent(target: ManagementTarget, builtin: AgentConfig): Promise<string> {
  const copy: AgentConfig = { ...builtin, scope: target.scope, file: undefined }
  const filePath = await writeAgentFile(target, copy)
  return `ejected ${builtin.name} to ${filePath}`
}

/** reset：删除作用域自定义文件与 overrides 条目。 */
export async function resetAgent(target: ManagementTarget, agentName: string, hasBuiltin: boolean): Promise<string> {
  const overrides = await readOverrides(target)
  const hadOverride = overrides.agents[agentName] !== undefined
  delete overrides.agents[agentName]
  await writeOverrides(target, overrides)
  let removedFile = false
  let fileError: string | undefined
  const filePath = path.join(target.dir, `${frontmatterNameForConfig({ name: agentName })}.md`)
  try {
    await rm(filePath, { force: true })
    removedFile = true
  } catch (error) {
    // 文件删除失败（如权限）要告知用户，而不是静默返回成功
    fileError = String(error)
  }
  if (!hadOverride && !removedFile) {
    if (!hasBuiltin) return `no custom file or override found for ${agentName} in ${target.scope} scope`
  }
  if (fileError && !removedFile) {
    return `reset ${agentName} in ${target.scope} scope: override removed, but file removal failed (${fileError})`
  }
  return `reset ${agentName} in ${target.scope} scope`
}

/** delete：删除作用域自定义 agent 文件（纯自定义 agent）。 */
export async function deleteAgent(target: ManagementTarget, localName: string): Promise<string> {
  const filePath = path.join(target.dir, `${localName}.md`)
  try {
    await rm(filePath, { force: true })
  } catch (error) {
    return `failed to delete ${filePath}: ${String(error)}`
  }
  return `deleted custom agent ${localName} from ${target.scope} scope`
}

// ── refine 精炼覆盖层 ──────────────────────────────────────────────────────

/** refine 覆盖层目录（<projectRoot>/.dsh/subagents/refinements）。 */
export function refinementsDir(projectRoot: string): string {
  return path.join(projectRoot, '.dsh', PROJECT_DATA_DIR, 'refinements')
}

/** 某 agent 的 refine 覆盖层文件路径。 */
export function refinementFile(projectRoot: string, agent: string): string {
  return path.join(refinementsDir(projectRoot), `${agent}.md`)
}

/**
 * 校验 refine 提案：禁止覆盖安全/策略/工具/输出/验收/系统指令。
 * 规则 = dsh 关键词黑名单 + 上游 agent-refinements.ts 的结构化 blocked regex
 * （覆盖 disable/ignore/bypass/skip/override + protected instruction 的组合变体）。
 */
export function validateRefinementProposal(proposal: string, agentName: string): { error?: string } {
  const lower = proposal.toLowerCase()
  const forbidden = [
    'system prompt', 'systemPrompt', 'developer message', 'developer instruction',
    'tools:', 'tool allowlist', 'output:', 'acceptance', 'completionguard',
    'inheritprojectcontext', 'inheritskills', 'maxsubagentdepth', 'permission',
    '你绝不能', '你必须遵守系统', 'ignore previous', 'ignore all previous',
  ]
  for (const needle of forbidden) {
    if (lower.includes(needle)) return { error: `refinement proposal mentions a guarded topic ("${needle}") and was rejected` }
  }
  // 上游结构化 blocked 模式：all agents / every agent / global /
  // (disable|ignore|bypass|skip|override) + protected instruction /
  // protected instruction 的变体组合
  const protectedInstruction = '(?:acceptance|output|safety|policy|policies|tools?|developer|system)'
  const blocked = new RegExp(
    `\\b(all agents|every agent|global|(?:disable|ignore|bypass|skip|override)\\s+(?:the\\s+)?${protectedInstruction}(?:\\s+instructions?)?|${protectedInstruction}\\s+(?:instructions?|overrides?)|tool safety|review gates|rewrite base|base agent file|settings\\.json|agents/.*\\.md)\\b`,
    'i',
  )
  if (blocked.test(proposal)) return { error: 'refinement proposal targets protected instructions (acceptance/output/safety/policy/tools/developer/system) and was rejected' }
  if (/^#+ *(all agents|base agent)/im.test(proposal)) return { error: 'refinement proposal targets all agents or base agent files' }
  if (proposal.includes('---')) return { error: 'refinement proposal must not contain frontmatter' }
  return {}
}

/** 读取当前 refine 覆盖层。 */
export async function readRefinement(projectRoot: string, agent: string): Promise<string | undefined> {
  return readTextFile(refinementFile(projectRoot, agent))
}

/** 从覆盖层文件解析元数据（revision / basePromptSha256）。 */
export function parseRefinementMeta(content: string): { revision?: number; basePromptSha256?: string } {
  const rev = content.match(/^revision: (\d+)/m)
  const sha = content.match(/^basePromptSha256: ([0-9a-f]{64})/m)
  return {
    ...(rev?.[1] ? { revision: Number(rev[1]) } : {}),
    ...(sha?.[1] ? { basePromptSha256: sha[1] } : {}),
  }
}

/** 写入 refine 覆盖层（旧版本先快照到 .rev-N；可选记录 base prompt 哈希供漂移检测）。 */
export async function writeRefinement(projectRoot: string, agent: string, proposal: string, basePromptSha256?: string): Promise<{ path: string; revision: number }> {
  const dir = refinementsDir(projectRoot)
  const filePath = refinementFile(projectRoot, agent)
  const previous = await readTextFile(filePath)
  let revision = 1
  const revMatch = previous?.match(/^revision: (\d+)/m)
  if (revMatch?.[1]) revision = Number(revMatch[1]) + 1
  await mkdir(dir, { recursive: true })
  if (previous !== undefined) {
    await writeTextAtomic(`${filePath}.rev-${revision - 1}`, previous)
  }
  const meta = [`# Refinement overlay for \`${agent}\``, `revision: ${revision}`, ...(basePromptSha256 ? [`basePromptSha256: ${basePromptSha256}`] : [])].join('\n')
  await writeTextAtomic(filePath, `${meta}\n\n${proposal.trim()}\n`)
  return { path: filePath, revision }
}

/** 回滚 refine 覆盖层到上一版本；无快照时返回 undefined。 */
export async function rollbackRefinement(projectRoot: string, agent: string): Promise<string | undefined> {
  const filePath = refinementFile(projectRoot, agent)
  const previous = await readTextFile(filePath)
  const revMatch = previous?.match(/^revision: (\d+)/m)
  const current = revMatch?.[1] ? Number(revMatch[1]) : 1
  const snapshot = await readTextFile(`${filePath}.rev-${current - 1}`)
  if (snapshot === undefined) return undefined
  await writeTextAtomic(filePath, snapshot)
  return snapshot
}
