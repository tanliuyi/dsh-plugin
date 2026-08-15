/**
 * 扩展记忆存储 — 取代上游基于 better-sqlite3/FTS5 的 sqlite-memory-store。
 *
 * 差异（见 README）：上游把记忆镜像进 SQLite（FTS5 trigram 分词）；本移植
 * 把镜像保存在 `$DSH_HOME/hermes-memory/extended-memory.json`，搜索在内存中
 * 完成：分词 + 子串匹配（含 CJK 子串，短词也可命中，不受 trigram 三字符限制）。
 * 数据量（几千条目）下性能无差异，且零原生依赖。
 *
 * 语义与上游保持一致：
 * - Markdown 是权威源，扩展存储是搜索镜像；
 * - 每次变异后按目标全量对账（新条目插入、已有条目保留 created、孤儿删除）；
 * - `/memory-sync-markdown` 可随时手动重跑对账。
 */

import { randomUUID } from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { ENTRY_DELIMITER, FAILURES_FILE, MEMORY_FILE, USER_FILE } from '../constants.ts'
import type { MemoryCategory, MemoryTarget } from '../types.ts'
import { resolveMemoryRoot, resolveProjectsRoot } from '../paths.ts'

/** 扩展存储中的一条记忆。 */
export interface ExtendedMemoryEntry {
  /** 稳定 id */
  id: string
  /** 目标：memory / user / failure */
  target: MemoryTarget
  /** 项目名（project 作用域），全局为 null */
  project: string | null
  /** failure 目标的分类 */
  category?: MemoryCategory
  /** failure 目标的失败原因 */
  failureReason?: string
  /** 内容（已去元数据注释） */
  content: string
  /** ISO 创建日期 */
  created: string
  /** ISO 最近引用日期 */
  lastReferenced: string
}

/** 搜索过滤条件。 */
export interface ExtendedMemorySearchFilter {
  project?: string
  target?: string
  category?: string
  limit?: number
}

/** 对账结果计数。 */
export interface ReconcileCounters {
  inserted: number
  existing: number
  removed: number
}

interface ExtendedStoreFile {
  version: number
  entries: ExtendedMemoryEntry[]
}

const STORE_VERSION = 1
const STORE_FILE = 'extended-memory.json'
const MAX_SEARCH_LIMIT = 20

/** 从 § 分隔的 Markdown 内容解析条目（去掉元数据注释交给调用方）。 */
function splitEntries(raw: string): string[] {
  const content = raw.trim()
  if (!content) return []
  return content.split(ENTRY_DELIMITER).map((entry) => entry.trim()).filter(Boolean)
}

/** 从编码条目中提取元数据（created/last/project），无元数据时用今天。 */
function decodeEntry(raw: string): { text: string; created: string; lastReferenced: string; project: string | null } {
  const match = raw.match(/^(.*?)\s*<!--\s*created=([^,]+),\s*last=([^,>]+)(?:,\s*project64=([A-Za-z0-9_-]+))?\s*-->\s*$/s)
  if (match) {
    let project: string | null = null
    if (match[4]) {
      try { project = Buffer.from(match[4], 'base64url').toString('utf-8').trim() || null } catch { /* ignore */ }
    }
    return { text: match[1]!.trim(), created: match[2]!.trim(), lastReferenced: match[3]!.trim(), project }
  }
  const today = new Date().toISOString().slice(0, 10)
  return { text: raw.trim(), created: today, lastReferenced: today, project: null }
}

/** 从失败条目文本解析分类标签（"[correction] ..."）。 */
function parseFailureCategory(text: string): MemoryCategory | undefined {
  const match = /^\[(failure|correction|insight|preference|convention|tool-quirk)\]\s*/.exec(text)
  if (!match) return undefined
  return match[1] as MemoryCategory
}

function stripCategoryTag(text: string): string {
  return text.replace(/^\[(failure|correction|insight|preference|convention|tool-quirk)\]\s*/, '')
}

/**
 * 扩展记忆存储：JSON 文件镜像 + 内存关键词搜索。
 */
export class ExtendedMemoryStore {
  private entries: ExtendedMemoryEntry[] = []
  private loaded = false

  constructor(private memoryDir?: string) {}

  private get filePath(): string {
    return path.join(resolveMemoryRoot(this.memoryDir), STORE_FILE)
  }

  /**
   * 从磁盘加载镜像。
   */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      const parsed = JSON.parse(raw) as Partial<ExtendedStoreFile>
      this.entries = Array.isArray(parsed.entries) ? parsed.entries : []
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.entries = []
    }
    this.loaded = true
  }

  isLoaded(): boolean {
    return this.loaded
  }

  /**
   * 统计：总条数 + 各项目条数。
   */
  getStats(): { total: number; projects: Array<{ project: string; count: number }> } {
    const byProject = new Map<string, number>()
    for (const entry of this.entries) {
      if (entry.project) {
        byProject.set(entry.project, (byProject.get(entry.project) ?? 0) + 1)
      }
    }
    return {
      total: this.entries.length,
      projects: [...byProject.entries()]
        .map(([project, count]) => ({ project, count }))
        .sort((a, b) => b.count - a.count),
    }
  }

  /**
   * 搜索镜像。
   * 查询按空白分词，全部词都必须命中（AND 语义）；词命中分为整词与子串两级，
   * 子串匹配对 CJK 短词也生效。排序：整词命中 > 子串命中，词数多者优先，
   * 再按最近引用时间倒序。
   * @param query - 查询文本
   * @param filter - 过滤条件
   */
  search(query: string, filter: ExtendedMemorySearchFilter = {}): ExtendedMemoryEntry[] {
    const terms = query
      .toLowerCase()
      .split(/\s+/)
      .map((term) => term.trim())
      .filter(Boolean)
    if (terms.length === 0) return []

    const limit = Math.min(Math.max(1, filter.limit ?? 10), MAX_SEARCH_LIMIT)
    const target = filter.target as MemoryTarget | undefined
    const category = filter.category as MemoryCategory | undefined

    const scored: Array<{ entry: ExtendedMemoryEntry; score: number }> = []
    for (const entry of this.entries) {
      if (target && entry.target !== target) continue
      if (filter.project !== undefined && entry.project !== filter.project) continue
      if (category && entry.category !== category) continue

      const haystack = entry.content.toLowerCase()
      let matchedTerms = 0
      let wordMatches = 0
      let allMatch = true
      for (const term of terms) {
        if (!haystack.includes(term)) {
          allMatch = false
          break
        }
        matchedTerms++
        if (new RegExp(`\\b${escapeRegex(term)}\\b`, 'i').test(entry.content)) {
          wordMatches++
        }
      }
      if (!allMatch) continue

      // 得分：整词命中优先；词数多者优先。
      const score = matchedTerms * 10 + wordMatches
      scored.push({ entry, score })
    }

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      return b.entry.lastReferenced.localeCompare(a.entry.lastReferenced)
    })

    return scored.slice(0, limit).map(({ entry }) => entry)
  }

  /**
   * 用 Markdown 权威源对账一个目标（全量替换式镜像）。
   * 相同的 (target, project, 去标签文本) 保留原 created/lastReferenced，
   * 新条目插入，消失的条目删除。
   * @param target - 目标
   * @param entries - Markdown 原始条目（含元数据注释）
   * @param project - 项目名（null = 全局）
   * @returns 对账计数
   */
  async reconcileTarget(
    target: MemoryTarget,
    entries: string[],
    project: string | null = null,
  ): Promise<ReconcileCounters> {
    let inserted = 0
    let existing = 0
    let removed = 0

    const incoming: ExtendedMemoryEntry[] = []
    const seen = new Set<string>()
    for (const raw of entries) {
      const decoded = decodeEntry(raw)
      const category = target === 'failure' ? parseFailureCategory(decoded.text) : undefined
      const content = category ? stripCategoryTag(decoded.text) : decoded.text
      const key = `${target}\u0000${project ?? ''}\u0000${content}`
      if (seen.has(key)) continue
      seen.add(key)

      const prior = this.entries.find(
        (entry) => entry.target === target
          && entry.project === project
          && entry.content === content
          && entry.category === category,
      )
      if (prior) {
        existing++
        incoming.push({
          ...prior,
          lastReferenced: decoded.lastReferenced,
          created: prior.created,
        })
      } else {
        inserted++
        incoming.push({
          id: randomUUID(),
          target,
          project,
          category,
          content,
          created: decoded.created,
          lastReferenced: decoded.lastReferenced,
        })
      }
    }

    const removedEntries = this.entries.filter(
      (entry) => entry.target === target && entry.project === project,
    )
    removed = removedEntries.length - incoming.length

    this.entries = [
      ...this.entries.filter(
        (entry) => !(entry.target === target && entry.project === project),
      ),
      ...incoming,
    ]

    await this.save()
    return { inserted, existing, removed }
  }

  /**
   * 对账 failures 目标：按项目拆分（Markdown 条目中编码的 project64 元数据）。
   * @param entries - failures.md 原始条目
   */
  async reconcileFailures(entries: string[]): Promise<ReconcileCounters> {
    const byProject = new Map<string | null, string[]>()
    for (const raw of entries) {
      const project = decodeEntry(raw).project
      const list = byProject.get(project) ?? []
      list.push(raw)
      byProject.set(project, list)
    }

    const totals: ReconcileCounters = { inserted: 0, existing: 0, removed: 0 }
    for (const [project, projectEntries] of byProject) {
      const result = await this.reconcileTarget('failure', projectEntries, project)
      totals.inserted += result.inserted
      totals.existing += result.existing
      totals.removed += result.removed
    }
    // 清除已不存在的项目作用域 failure 行。
    const remainingProjects = new Set(byProject.keys())
    const orphaned = this.entries.filter(
      (entry) => entry.target === 'failure' && !remainingProjects.has(entry.project),
    )
    if (orphaned.length > 0) {
      this.entries = this.entries.filter((entry) => !orphaned.includes(entry))
      totals.removed += orphaned.length
      await this.save()
    }
    return totals
  }

  /**
   * 从磁盘上的 Markdown 文件全量对账（/memory-sync-markdown 用）。
   * @param files - { target, filePath, project } 列表
   */
  async reconcileFiles(files: Array<{ target: MemoryTarget; filePath: string; project?: string | null }>): Promise<ReconcileCounters> {
    const totals: ReconcileCounters = { inserted: 0, existing: 0, removed: 0 }
    for (const file of files) {
      let raw = ''
      try {
        raw = await fs.readFile(file.filePath, 'utf-8')
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
      const entries = splitEntries(raw)
      const result = file.target === 'failure'
        ? await this.reconcileFailures(entries)
        : await this.reconcileTarget(file.target, entries, file.project ?? null)
      totals.inserted += result.inserted
      totals.existing += result.existing
      totals.removed += result.removed
    }
    return totals
  }

  /**
   * 标准对账入口：全局 memory/user/failure 文件 + 各项目 MEMORY.md。
   * @param globalDir - 全局存储目录
   * @param projectsMemoryDir - 项目记忆目录配置
   */
  async reconcileAllMarkdown(globalDir: string, projectsMemoryDir = 'projects-memory'): Promise<ReconcileCounters> {
    const files: Array<{ target: MemoryTarget; filePath: string; project?: string | null }> = [
      { target: 'memory', filePath: path.join(globalDir, MEMORY_FILE) },
      { target: 'user', filePath: path.join(globalDir, USER_FILE) },
      { target: 'failure', filePath: path.join(globalDir, FAILURES_FILE) },
    ]

    const projectsRoot = resolveProjectsRoot(projectsMemoryDir)
    let projectNames: string[] = []
    try {
      const entries = await fs.readdir(projectsRoot, { withFileTypes: true })
      projectNames = entries
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => entry.name)
    } catch {
      // 项目目录不存在 — 无项目记忆
    }

    for (const name of projectNames) {
      files.push({
        target: 'memory',
        filePath: path.join(projectsRoot, name, MEMORY_FILE),
        project: name,
      })
    }

    return this.reconcileFiles(files)
  }

  /**
   * 变异观察者适配：MemoryStore.setMutationObserver 的回调。
   * @param target - 目标
   * @param entries - Markdown 原始条目
   * @param project - 项目名
   */
  observeMutation = async (target: MemoryTarget, entries: string[], project: string | null = null): Promise<string | null> => {
    try {
      if (target === 'failure') {
        await this.reconcileFailures(entries)
      } else {
        await this.reconcileTarget(target, entries, project)
      }
      return null
    } catch (error) {
      return `Search mirror sync failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  /** 原子写盘：同目录临时文件 + rename。 */
  private async save(): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    const tmpPath = `${this.filePath}.tmp-${randomUUID()}`
    try {
      const payload: ExtendedStoreFile = { version: STORE_VERSION, entries: this.entries }
      await fs.writeFile(tmpPath, JSON.stringify(payload), 'utf-8')
      await fs.rename(tmpPath, this.filePath)
    } finally {
      try { await fs.unlink(tmpPath) } catch { /* ignore */ }
    }
  }
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
