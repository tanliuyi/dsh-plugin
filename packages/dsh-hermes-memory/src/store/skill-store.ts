/**
 * SkillStore — 程序性记忆，存为带 frontmatter 的 SKILL.md 文件。
 *
 * 全局技能：$DSH_HOME/hermes-memory/skills/<slug>/SKILL.md
 * 项目技能：$DSH_HOME/projects-memory/<project>/skills/<slug>/SKILL.md
 *
 * 移植自 pi-hermes-memory/src/store/skill-store.ts（MIT）。与上游的差异：
 * - 去掉 Pi 全局技能目录（~/.pi/agent/skills/）的影子占用检查（dsh 无此布局，
 *   优先级由 dsh 技能注册表按 provider 处理）；
 * - 去掉 legacy 迁移逻辑（无历史布局需要迁移）；
 * - 保留：slug/frontmatter、重复/相似/重名守卫、patch 段归一化、move、delete。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import { scanContent } from './content-scanner.ts'
import {
  buildSkillId,
  exists,
  formatFrontmatter,
  jaccardSimilarity,
  parseFrontmatter,
  parseSkillId,
  slugify,
  today,
  tokenizeForSimilarity,
} from './skill-utils.ts'
import type { SkillDocument, SkillIndex, SkillResult, SkillScope } from '../types.ts'

interface SkillLocation {
  skillId: string
  scope: SkillScope
  slug: string
  fileName: string
  path: string
  projectName?: string
}

/** patch 时按列表格式化的段。 */
const LIST_SECTIONS = new Set(['procedure', 'pitfalls', 'verification'])

const SIMILARITY_THRESHOLD = 0.55
const NAME_COLLISION_SIMILARITY_THRESHOLD = 0.25

function normalizeSectionName(section: string): string {
  return section.replace(/^#+\s*/, '').trim()
}

function isExactSectionHeader(line: string, section: string): boolean {
  const heading = line.trim().match(/^##\s+(.+?)\s*$/)
  if (!heading) return false
  return heading[1]!.trim().toLowerCase() === section.trim().toLowerCase()
}

function looksLikeJsonArray(content: string): boolean {
  const trimmed = content.trim()
  return trimmed.startsWith('[') && trimmed.endsWith(']')
}

function looksLikeJsonObject(content: string): boolean {
  const trimmed = content.trim()
  return trimmed.startsWith('{') && trimmed.endsWith('}')
}

function formatPatchList(section: string, items: string[]): string {
  const cleaned = items.map((item) => item.trim()).filter(Boolean)
  if (cleaned.length === 0) return ''
  const key = section.trim().toLowerCase()
  if (key === 'pitfalls') {
    return cleaned.map((item) => `- ${item.replace(/^[-*]\s+/, '')}`).join('\n')
  }
  // Procedure / Verification 默认有序步骤。
  return cleaned
    .map((item, index) => `${index + 1}. ${item.replace(/^\d+\.\s+/, '').replace(/^[-*]\s+/, '')}`)
    .join('\n')
}

/**
 * 归一化/校验 patch 自由内容，防止 LLM 格式漂移清空或拼接技能段。
 * 列表形段接受 JSON 字符串数组；拒绝空、对象与注入标题的载荷。
 * @param section - 段名
 * @param rawContent - 原始内容
 * @returns 归一化内容或错误
 */
export function normalizeSkillPatchContent(
  section: string,
  rawContent: string,
): { content: string } | { error: string } {
  const sectionName = normalizeSectionName(section)
  if (!sectionName) {
    return { error: 'section is required for patch.' }
  }

  let content = typeof rawContent === 'string' ? rawContent.trim() : ''
  if (!content) {
    return {
      error: 'New content is required for patch. Prefer structured fields (procedure_steps, pitfalls, verification_steps, when_to_use) over free-form content.',
    }
  }

  if (looksLikeJsonObject(content)) {
    return {
      error: 'Patch content looks like a JSON object. Provide Markdown section body or a string array via structured fields.',
    }
  }

  if (looksLikeJsonArray(content)) {
    try {
      const parsed: unknown = JSON.parse(content)
      if (!Array.isArray(parsed)) {
        return { error: 'Patch content looks like JSON but is not a string array.' }
      }
      const items = parsed
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean)
      if (items.length === 0) {
        return { error: 'Patch content JSON array must contain non-empty strings.' }
      }
      const key = sectionName.toLowerCase()
      if (key === 'when to use') {
        content = items.join('\n\n')
      } else if (LIST_SECTIONS.has(key)) {
        content = formatPatchList(sectionName, items)
      } else {
        content = items.map((item) => `- ${item}`).join('\n')
      }
    } catch {
      return {
        error: 'Patch content looks like a JSON array but could not be parsed. Use Markdown or structured string[] fields.',
      }
    }
  }

  // 拒绝会在正文中间注入额外 ## 段的载荷。
  if (/^#{1,6}\s+\S/m.test(content)) {
    return {
      error: 'Patch content must not include Markdown section headers (## ...). Patch only the body of the target section.',
    }
  }

  if (!content.trim()) {
    return { error: 'New content is required for patch.' }
  }

  return { content: content.trim() }
}

export interface SkillStoreOptions {
  /** 全局技能目录。 */
  globalSkillsDir?: string
  /** 项目记忆根目录（$DSH_HOME/projects-memory）。 */
  projectsRoot?: string
  /** 项目技能目录（当前项目）。 */
  projectSkillsDir?: string | null
  /** 当前项目名。 */
  projectName?: string | null
}

/**
 * 技能存储：SKILL.md 文件管理。
 */
export class SkillStore {
  private globalSkillsDir: string
  private projectsRoot: string
  private projectSkillsDir: string | null
  private projectName: string | null

  constructor(options: SkillStoreOptions = {}) {
    this.globalSkillsDir = options.globalSkillsDir ?? path.join('hermes-memory', 'skills')
    this.projectsRoot = options.projectsRoot ?? path.join('projects-memory')
    this.projectSkillsDir = options.projectSkillsDir ?? null
    this.projectName = options.projectName ?? null
  }

  /** 全局技能目录。 */
  getGlobalSkillsDir(): string {
    return this.globalSkillsDir
  }

  /** 项目技能目录（无项目时为 null）。 */
  getProjectSkillsDir(): string | null {
    return this.projectSkillsDir
  }

  /** 当前项目名。 */
  getProjectName(): string | null {
    return this.projectName
  }

  /**
   * 更新项目上下文。
   * @param projectName - 项目名
   * @param projectSkillsDir - 项目技能目录
   */
  setProjectContext(projectName: string | null, projectSkillsDir: string | null): void {
    this.projectName = projectName
    this.projectSkillsDir = projectSkillsDir
  }

  /**
   * 确保技能根目录存在。
   */
  async ensureDiscoveredRoots(): Promise<void> {
    await fs.mkdir(this.globalSkillsDir, { recursive: true })
    if (this.projectSkillsDir) {
      await fs.mkdir(this.projectSkillsDir, { recursive: true })
    }
  }

  private getScopeRoot(scope: SkillScope): string | null {
    if (scope === 'global') return this.globalSkillsDir
    return this.projectSkillsDir
  }

  /** 由项目名解析项目技能目录（项目 id 中内嵌项目名，读写无需活跃上下文）。 */
  private projectSkillsDirFor(projectName: string): string {
    return path.join(this.projectsRoot, projectName, 'skills')
  }

  private async collectLocations(scope?: SkillScope): Promise<SkillLocation[]> {
    const locations: SkillLocation[] = []

    if (scope !== 'project') {
      const globalRoot = this.globalSkillsDir
      let names: string[] = []
      try {
        names = (await fs.readdir(globalRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
          .map((entry) => entry.name)
      } catch {
        return locations
      }
      for (const slug of names.sort()) {
        const filePath = path.join(globalRoot, slug, 'SKILL.md')
        if (await exists(filePath)) {
          locations.push({
            skillId: buildSkillId('global', slug),
            scope: 'global',
            slug,
            fileName: 'SKILL.md',
            path: filePath,
          })
        }
      }
    }

    if (scope !== 'global' && this.projectSkillsDir) {
      const projectRoot = this.projectSkillsDir
      let names: string[] = []
      try {
        names = (await fs.readdir(projectRoot, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
          .map((entry) => entry.name)
      } catch {
        return locations
      }
      const projectName = this.projectName ?? ''
      for (const slug of names.sort()) {
        const filePath = path.join(projectRoot, slug, 'SKILL.md')
        if (await exists(filePath)) {
          locations.push({
            skillId: buildSkillId('project', slug, projectName),
            scope: 'project',
            slug,
            fileName: 'SKILL.md',
            path: filePath,
            projectName: projectName || undefined,
          })
        }
      }
    }

    return locations
  }

  private async readLocation(location: SkillLocation): Promise<SkillDocument | null> {
    try {
      const raw = await fs.readFile(location.path, 'utf-8')
      const parsed = parseFrontmatter(raw)
      const meta = parsed.meta
      return {
        skillId: location.skillId,
        scope: location.scope,
        fileName: location.fileName,
        path: location.path,
        projectName: location.projectName,
        name: meta.name?.trim() || location.slug,
        displayName: meta.display_name?.trim() || undefined,
        description: meta.description?.trim() || '',
        created: meta.created || today(),
        updated: meta.updated || today(),
        version: Number.parseInt(meta.version || '1', 10) || 1,
        body: parsed.body,
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  private async findLocationById(skillId: string): Promise<SkillLocation | null> {
    const parsed = parseSkillId(skillId)
    if (!parsed) return null

    let root: string | null
    if (parsed.scope === 'global') {
      root = this.globalSkillsDir
    } else {
      root = parsed.projectName ? this.projectSkillsDirFor(parsed.projectName) : this.projectSkillsDir
    }
    if (!root) return null
    const filePath = path.join(root, parsed.slug, 'SKILL.md')
    if (!(await exists(filePath))) return null
    return {
      skillId,
      scope: parsed.scope,
      slug: parsed.slug,
      fileName: 'SKILL.md',
      path: filePath,
      projectName: parsed.projectName,
    }
  }

  private toIndex(doc: SkillDocument): SkillIndex {
    return {
      skillId: doc.skillId,
      scope: doc.scope,
      fileName: doc.fileName,
      path: doc.path,
      projectName: doc.projectName,
      name: doc.name,
      displayName: doc.displayName,
      description: doc.description,
      created: doc.created,
      updated: doc.updated,
    }
  }

  /**
   * 列出技能索引（按更新时间倒序）。
   * @param scope - 可选作用域过滤
   */
  async loadIndex(scope?: SkillScope): Promise<SkillIndex[]> {
    const locations = await this.collectLocations(scope)
    const skills: SkillIndex[] = []
    for (const location of locations) {
      const doc = await this.readLocation(location)
      if (doc) skills.push(this.toIndex(doc))
    }
    return skills.sort((a, b) => {
      if (a.updated !== b.updated) return b.updated.localeCompare(a.updated)
      if (a.created !== b.created) return b.created.localeCompare(a.created)
      if (a.scope !== b.scope) return a.scope.localeCompare(b.scope)
      return (a.displayName || a.name).localeCompare(b.displayName || b.name)
    })
  }

  /**
   * 读取完整技能文档。
   * @param skillId - 技能 id
   */
  async loadSkill(skillId: string): Promise<SkillDocument | null> {
    const location = await this.findLocationById(skillId)
    if (!location) return null
    return this.readLocation(location)
  }

  private async findSimilarGlobalSkillIds(slug: string, description: string): Promise<string[]> {
    const slugTokens = tokenizeForSimilarity(slug)
    const descriptionTokens = tokenizeForSimilarity(description)
    const candidates = await this.collectLocations('global')
    const similar: string[] = []
    for (const location of candidates) {
      if (location.slug === slug) continue
      const doc = await this.readLocation(location)
      if (!doc) continue
      const candidateSlugTokens = tokenizeForSimilarity(location.slug)
      const candidateDescriptionTokens = tokenizeForSimilarity(doc.description)
      const nameSimilarity = jaccardSimilarity(slugTokens, candidateSlugTokens)
      const descriptionSimilarity = jaccardSimilarity(descriptionTokens, candidateDescriptionTokens)
      if (nameSimilarity > NAME_COLLISION_SIMILARITY_THRESHOLD && descriptionSimilarity > SIMILARITY_THRESHOLD) {
        similar.push(location.skillId)
      }
    }
    return similar
  }

  private async findNameCollisionGlobalSkillIds(slug: string, description: string): Promise<string[]> {
    const slugTokens = tokenizeForSimilarity(slug)
    const descriptionTokens = tokenizeForSimilarity(description)
    const candidates = await this.collectLocations('global')
    const collisions: string[] = []
    for (const location of candidates) {
      if (location.slug === slug) continue
      const doc = await this.readLocation(location)
      if (!doc) continue
      const nameSimilarity = jaccardSimilarity(slugTokens, tokenizeForSimilarity(location.slug))
      if (nameSimilarity > NAME_COLLISION_SIMILARITY_THRESHOLD) {
        const descriptionSimilarity = jaccardSimilarity(descriptionTokens, tokenizeForSimilarity(doc.description))
        if (descriptionSimilarity <= SIMILARITY_THRESHOLD) {
          collisions.push(location.skillId)
        }
      }
    }
    return collisions
  }

  private resolveScope(scope: SkillScope | undefined, name: string, _description: string, _body: string): SkillScope | null {
    if (scope === 'global' || scope === 'project') return scope
    return null
  }

  /**
   * 创建技能。
   * @param name - 技能名
   * @param description - 一句话描述
   * @param body - 正文
   * @param scope - 作用域（必填）
   */
  async create(name: string, description: string, body: string, scope?: SkillScope): Promise<SkillResult> {
    name = name.trim()
    description = description.trim()
    body = body.trim()

    if (!name) return { success: false, error: 'Skill name is required.' }
    if (!description) return { success: false, error: 'Skill description is required.' }
    if (!body) return { success: false, error: 'Skill body is required.' }

    const scanError = scanContent(`${name} ${description} ${body}`)
    if (scanError) return { success: false, error: scanError }

    const slug = slugify(name)
    if (!slug) return { success: false, error: 'Skill name produces empty slug.' }

    const resolvedScope = this.resolveScope(scope, name, description, body)
    if (!resolvedScope) {
      return { success: false, error: "Scope is required for create. Use 'global' or 'project'." }
    }

    const root = this.getScopeRoot(resolvedScope)
    if (!root) {
      return { success: false, error: 'Project skills require an active project.' }
    }

    const skillId = buildSkillId(resolvedScope, slug, this.projectName)
    const existing = await this.findLocationById(skillId)
    if (existing) {
      return {
        success: false,
        error: `Skill '${slug}' already exists (${skillId}). Use 'patch' or 'update' to update it.`,
        conflictType: 'duplicate',
        similarSkillIds: [skillId],
        suggestedAction: 'patch',
      }
    }

    if (resolvedScope === 'global') {
      const similarSkillIds = await this.findSimilarGlobalSkillIds(slug, description)
      if (similarSkillIds.length > 0) {
        const targetId = similarSkillIds[0]!
        return {
          success: false,
          error: `A similar global skill already exists (${targetId}). Enhance the existing skill with new learnings/failures using 'patch' or 'update' instead of creating a duplicate.`,
          conflictType: 'similar',
          similarSkillIds,
          suggestedAction: 'patch',
        }
      }

      const collidingNameSkillIds = await this.findNameCollisionGlobalSkillIds(slug, description)
      if (collidingNameSkillIds.length > 0) {
        const targetId = collidingNameSkillIds[0]!
        return {
          success: false,
          error: `A near-name global skill already exists (${targetId}) but with different intent. Use a clearer differentiated name for the new skill, or patch/update the existing skill if the intent is actually the same.`,
          conflictType: 'name-collision',
          similarSkillIds: collidingNameSkillIds,
          suggestedAction: 'rename',
        }
      }
    }

    const filePath = path.join(root, slug, 'SKILL.md')
    await fs.mkdir(path.dirname(filePath), { recursive: true })

    const displayName = name
    const storedName = slug
    const stamp = today()
    await this.atomicWrite(filePath, formatFrontmatter({
      name: storedName,
      displayName,
      description,
      version: 1,
      created: stamp,
      updated: stamp,
      body,
    }))

    return {
      success: true,
      message: `Skill '${displayName}' created as a ${resolvedScope} skill.`,
      fileName: path.basename(filePath),
      skillId,
      scope: resolvedScope,
      path: filePath,
    }
  }

  /**
   * patch 技能的一个段。
   * @param skillId - 技能 id
   * @param section - 段名（如 Procedure / Pitfalls / Verification / When to Use）
   * @param newContent - 段正文
   */
  async patch(skillId: string, section: string, newContent: string): Promise<SkillResult> {
    const sectionName = normalizeSectionName(section)
    if (!sectionName) return { success: false, error: 'section is required for patch.' }

    const normalized = normalizeSkillPatchContent(sectionName, newContent)
    if ('error' in normalized) return { success: false, error: normalized.error }
    const content = normalized.content

    const scanError = scanContent(content)
    if (scanError) return { success: false, error: scanError }

    const doc = await this.loadSkill(skillId)
    if (!doc) return { success: false, error: `Skill '${skillId}' not found.` }

    const sectionHeader = `## ${sectionName}`
    const lines = doc.body.split('\n')
    let found = false
    const result: string[] = []

    for (let i = 0; i < lines.length; i++) {
      if (isExactSectionHeader(lines[i]!, sectionName)) {
        result.push(sectionHeader)
        // 保留多行正文为独立行，让后面的标题保持精确。
        for (const bodyLine of content.split('\n')) {
          result.push(bodyLine)
        }
        found = true
        i++
        while (i < lines.length && !lines[i]!.trim().startsWith('## ')) i++
        if (i < lines.length) result.push(lines[i]!)
      } else {
        result.push(lines[i]!)
      }
    }

    if (!found) {
      if (result.length > 0 && result[result.length - 1] !== '') result.push('')
      result.push(sectionHeader)
      for (const bodyLine of content.split('\n')) {
        result.push(bodyLine)
      }
    }

    await this.atomicWrite(doc.path, formatFrontmatter({
      name: doc.name,
      displayName: doc.displayName,
      description: doc.description,
      version: doc.version + 1,
      created: doc.created,
      updated: today(),
      body: result.join('\n').trim(),
    }))

    return {
      success: true,
      message: `Skill '${doc.displayName || doc.name}' section '${sectionName}' updated.`,
      fileName: doc.fileName,
      skillId: doc.skillId,
      scope: doc.scope,
      path: doc.path,
    }
  }

  /**
   * 整体更新技能的描述与/或正文。
   * @param skillId - 技能 id
   * @param description - 新描述（空 = 保留）
   * @param body - 新正文（空 = 保留）
   */
  async edit(skillId: string, description: string, body: string): Promise<SkillResult> {
    description = description.trim()
    body = body.trim()

    if (!description && !body) {
      return { success: false, error: 'At least one of description or body is required.' }
    }

    const doc = await this.loadSkill(skillId)
    if (!doc) return { success: false, error: `Skill '${skillId}' not found.` }

    const newDescription = description || doc.description
    const newBody = body || doc.body
    const scanError = scanContent(`${newDescription} ${newBody}`)
    if (scanError) return { success: false, error: scanError }

    await this.atomicWrite(doc.path, formatFrontmatter({
      name: doc.name,
      displayName: doc.displayName,
      description: newDescription,
      version: doc.version + 1,
      created: doc.created,
      updated: today(),
      body: newBody,
    }))

    return {
      success: true,
      message: `Skill '${doc.displayName || doc.name}' updated.`,
      fileName: doc.fileName,
      skillId: doc.skillId,
      scope: doc.scope,
      path: doc.path,
    }
  }

  /**
   * 在 global 与 project 作用域间移动技能（冲突安全）。
   * @param skillId - 技能 id
   * @param targetScope - 目标作用域
   */
  async move(skillId: string, targetScope: SkillScope): Promise<SkillResult> {
    const doc = await this.loadSkill(skillId)
    if (!doc) return { success: false, error: `Skill '${skillId}' not found.` }

    const parsed = parseSkillId(skillId)
    if (!parsed) return { success: false, error: `Skill '${skillId}' is invalid.` }

    if (doc.scope === targetScope) {
      return {
        success: true,
        message: `Skill '${doc.displayName || doc.name}' is already ${targetScope}.`,
        fileName: doc.fileName,
        skillId: doc.skillId,
        scope: doc.scope,
        path: doc.path,
      }
    }

    const targetRoot = this.getScopeRoot(targetScope)
    if (!targetRoot) {
      return { success: false, error: 'Project skills require an active project.' }
    }

    const targetSkillId = buildSkillId(targetScope, parsed.slug, this.projectName)
    const targetPath = path.join(targetRoot, parsed.slug, 'SKILL.md')
    if (await exists(targetPath)) {
      return {
        success: false,
        error: `Cannot move '${doc.displayName || doc.name}' to ${targetScope}: ${targetSkillId} already exists.`,
        conflictType: 'scope-conflict',
        similarSkillIds: [targetSkillId],
        suggestedAction: 'rename',
      }
    }

    if (targetScope === 'global') {
      const similarSkillIds = await this.findSimilarGlobalSkillIds(parsed.slug, doc.description)
      if (similarSkillIds.length > 0) {
        const targetId = similarSkillIds[0]!
        return {
          success: false,
          error: `Cannot move '${doc.displayName || doc.name}' to global: a similar global skill already exists (${targetId}).`,
          conflictType: 'similar',
          similarSkillIds,
          suggestedAction: 'patch',
        }
      }

      const collidingNameSkillIds = await this.findNameCollisionGlobalSkillIds(parsed.slug, doc.description)
      if (collidingNameSkillIds.length > 0) {
        const targetId = collidingNameSkillIds[0]!
        return {
          success: false,
          error: `Cannot move '${doc.displayName || doc.name}' to global: a near-name global skill already exists (${targetId}) with different intent.`,
          conflictType: 'name-collision',
          similarSkillIds: collidingNameSkillIds,
          suggestedAction: 'rename',
        }
      }
    }

    await fs.mkdir(path.dirname(targetPath), { recursive: true })

    // 同文件系统移动：先 rename 保证原子性，避免双副本窗口。
    try {
      await fs.rename(doc.path, targetPath)
      await this.removeEmptyParents(path.dirname(doc.path), this.getScopeRoot(doc.scope))
      return {
        success: true,
        message: `Skill '${doc.displayName || doc.name}' moved to ${targetScope}.`,
        fileName: path.basename(targetPath),
        skillId: targetSkillId,
        scope: targetScope,
        path: targetPath,
      }
    } catch (renameError) {
      const code = (renameError as NodeJS.ErrnoException)?.code
      if (code !== 'EXDEV') {
        return {
          success: false,
          error: `Move to ${targetScope} failed before copy for skill '${skillId}'. Source path: ${doc.path}. Destination path: ${targetPath}. Error: ${renameError instanceof Error ? renameError.message : String(renameError)}`,
        }
      }
      // 跨设备回退：复制后删源。
    }

    await this.atomicWrite(targetPath, formatFrontmatter({
      name: parsed.slug,
      displayName: doc.displayName,
      description: doc.description,
      version: doc.version,
      created: doc.created,
      updated: doc.updated,
      body: doc.body,
    }))

    try {
      await fs.unlink(doc.path)
      await this.removeEmptyParents(path.dirname(doc.path), this.getScopeRoot(doc.scope))
    } catch (error) {
      // 尽力回滚：源删除失败时移除目标副本，避免静默双副本。
      let rollbackFailed = false
      try {
        await fs.unlink(targetPath)
        await this.removeEmptyParents(path.dirname(targetPath), this.getScopeRoot(targetScope))
      } catch {
        rollbackFailed = true
      }

      return {
        success: false,
        error: rollbackFailed
          ? `Move to ${targetScope} failed while removing source skill '${skillId}', and rollback also failed. Source path: ${doc.path}. Destination path: ${targetPath}. Error: ${error instanceof Error ? error.message : String(error)}`
          : `Move to ${targetScope} failed while removing source skill '${skillId}'. Rolled back destination copy. Source path: ${doc.path}. Destination path: ${targetPath}. Error: ${error instanceof Error ? error.message : String(error)}`,
      }
    }

    return {
      success: true,
      message: `Skill '${doc.displayName || doc.name}' moved to ${targetScope}.`,
      fileName: path.basename(targetPath),
      skillId: targetSkillId,
      scope: targetScope,
      path: targetPath,
    }
  }

  /**
   * 删除技能。
   * @param skillId - 技能 id
   */
  async delete(skillId: string): Promise<SkillResult> {
    const doc = await this.loadSkill(skillId)
    if (!doc) return { success: false, error: `Skill '${skillId}' not found.` }

    await fs.unlink(doc.path)
    await this.removeEmptyParents(path.dirname(doc.path), this.getScopeRoot(doc.scope))

    return {
      success: true,
      message: `Skill '${doc.displayName || doc.name}' deleted.`,
      fileName: doc.fileName,
      skillId: doc.skillId,
      scope: doc.scope,
      path: doc.path,
    }
  }

  /** 删除作用域根下无内容（无其他文件）的父目录。 */
  private async removeEmptyParents(dir: string, scopeRoot: string | null): Promise<void> {
    if (!scopeRoot) return
    let current = dir
    const root = path.resolve(scopeRoot)
    while (path.resolve(current).startsWith(root) && path.resolve(current) !== root) {
      try {
        const entries = await fs.readdir(current)
        if (entries.length > 0) return
        await fs.rmdir(current)
        current = path.dirname(current)
      } catch {
        return
      }
    }
  }

  /** 原子写：同目录临时文件 + rename。 */
  private async atomicWrite(filePath: string, content: string): Promise<void> {
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    const tmpPath = path.join(path.dirname(filePath), `.tmp-${randomUUID()}`)
    try {
      await fs.writeFile(tmpPath, content, 'utf-8')
      await fs.rename(tmpPath, filePath)
    } finally {
      try { await fs.unlink(tmpPath) } catch { /* ignore */ }
    }
  }
}
