/**
 * Mission 存储：<base>/projects/<project-hash>/<mission-id>/record.json
 * 用户级全局索引只存指针。对应 pi-subagents 的 missions store。
 */

import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SubagentsConfig } from '../types.ts'
import { PROJECT_DATA_DIR } from '../types.ts'
import { expandTilde, projectHash, readJsonFile, resolvePath, writeJsonAtomic } from '../util.ts'

/** mission 生命周期状态。 */
export type MissionStatus = 'planned' | 'active' | 'waiting' | 'needs_decision' | 'completed' | 'failed' | 'cancelled' | 'budget-exhausted'

/** mission 关联的一次运行引用。 */
export interface MissionRunRef {
  runId: string
  key?: string
  agent: string
  task: string
  status: string
  updatedAt: number
  sessionFile?: string
  artifactDir?: string
  /** 对齐上游 runMode（附加 run 模式）。 */
  mode?: string
}

/** mission 中待决/已决的决策。 */
export interface MissionDecision {
  id: string
  question: string
  options?: string[]
  resolution?: string
  resolvedAt?: number
  createdAt: number
}

/** mission 的外部回执（CI/评审等证据）。 */
export interface MissionReceipt {
  kind: string
  status: string
  title: string
  url?: string
  description?: string
  createdAt: number
}

/** mission 记录（持久化到 record.json）。 */
export interface MissionRecord {
  id: string
  projectHash: string
  projectRoot: string
  title?: string
  summary?: string
  objective?: string
  goal: boolean
  /** 由运行自动创建（launchSingle/workflow 的 enclosing mission）；终态由 run 树驱动。 */
  auto?: boolean
  budget?: { tokens: number }
  labels?: string[]
  status: MissionStatus
  goalPaused: boolean
  createdAt: number
  updatedAt: number
  endedAt?: number
  runs: MissionRunRef[]
  decisions: MissionDecision[]
  receipts: MissionReceipt[]
  artifacts: string[]
  usage: { tokens?: number }
  nextReadyAction?: string
}

/** Mission 存储：record.json 原子读写 + 用户级全局索引指针。 */
export class MissionStore {
  constructor(
    private readonly config: SubagentsConfig,
    private readonly projectRoot: string,
    private readonly home = process.env.HOME ?? '',
  ) {}

  private baseDir(): string {
    const configured = this.config.missions.directory
    if (configured) {
      const expanded = expandTilde(configured)
      return path.isAbsolute(expanded) ? expanded : resolvePath(expanded, this.projectRoot)
    }
    return path.join(this.home, '.dsh', PROJECT_DATA_DIR, 'missions', 'projects')
  }

  projectDir(): string {
    return path.join(this.baseDir(), projectHash(this.projectRoot))
  }

  missionDir(id: string): string {
    return path.join(this.projectDir(), id)
  }

  recordFile(id: string): string {
    return path.join(this.missionDir(id), 'record.json')
  }

  stateFile(id: string): string {
    return path.join(this.missionDir(id), 'state.json')
  }

  private async indexFile(): Promise<string> {
    return path.join(this.home, '.dsh', PROJECT_DATA_DIR, 'missions', 'index.json')
  }

  /** 创建 mission 并写 record.json + 全局索引指针。 */
  async create(input: {
    title?: string
    summary?: string
    objective?: string
    goal?: boolean
    auto?: boolean
    budget?: { tokens: number }
    labels?: string[]
  }): Promise<MissionRecord> {
    const id = randomUUID().slice(0, 12)
    const now = Date.now()
    const record: MissionRecord = {
      id,
      projectHash: projectHash(this.projectRoot),
      projectRoot: this.projectRoot,
      title: input.title,
      summary: input.summary,
      objective: input.objective,
      goal: input.goal === true,
      auto: input.auto === true,
      budget: input.goal === true ? input.budget : undefined,
      labels: input.labels,
      status: 'planned',
      goalPaused: false,
      createdAt: now,
      updatedAt: now,
      runs: [],
      decisions: [],
      receipts: [],
      artifacts: [],
      usage: {},
    }
    await writeJsonAtomic(this.recordFile(id), record)
    await this.writeIndexPointer(id, record)
    return record
  }

  private async writeIndexPointer(id: string, record: MissionRecord): Promise<void> {
    if (!this.config.missions.globalIndex) return
    const file = await this.indexFile()
    const index = (await readJsonFile<Record<string, unknown>>(file)) ?? {}
    index[id] = { projectRoot: record.projectRoot, projectHash: record.projectHash, title: record.title ?? record.summary, status: record.status, updatedAt: record.updatedAt }
    await writeJsonAtomic(file, index)
  }

  /** 按 id 读取 mission。 */
  async get(id: string): Promise<MissionRecord | undefined> {
    return readJsonFile<MissionRecord>(this.recordFile(id))
  }

  /** 保存 mission（更新 updatedAt + 索引指针）。 */
  async save(record: MissionRecord): Promise<void> {
    record.updatedAt = Date.now()
    await writeJsonAtomic(this.recordFile(record.id), record)
    await this.writeIndexPointer(record.id, record)
  }

  /** 追加一个运行引用。 */
  async attachRun(id: string, ref: MissionRunRef): Promise<MissionRecord | undefined> {
    const record = await this.get(id)
    if (!record) return undefined
    const existing = record.runs.findIndex((run) => run.runId === ref.runId)
    if (existing >= 0) record.runs[existing] = ref
    else record.runs.push(ref)
    if (record.status === 'planned' || record.status === 'waiting') record.status = 'active'
    await this.save(record)
    return record
  }

  /** 更新一条运行引用的状态。 */
  async updateRunStatus(id: string, runId: string, status: string, extra?: Partial<MissionRunRef>): Promise<void> {
    const record = await this.get(id)
    if (!record) return
    const ref = record.runs.find((run) => run.runId === runId)
    if (ref) {
      ref.status = status
      ref.updatedAt = Date.now()
      Object.assign(ref, extra)
      await this.save(record)
    }
  }

  /** 终态判定：run 状态是否为进行中。 */
  private isRunActive(status: string): boolean {
    return status === 'queued' || status === 'running' || status === 'paused' || status === 'needs_attention'
  }

  /**
   * auto mission 的空闲终结：仅当 mission 由运行自动创建（auto: true）且
   * 所有关联 run 均已终态时置为 terminal。显式 mission 由用户管理生命周期，
   * 本方法不触碰（返回原记录）。
   */
  async finalizeIfIdle(id: string, status: 'completed' | 'failed'): Promise<MissionRecord | undefined> {
    const record = await this.get(id)
    if (!record || record.auto !== true) return record
    if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled' || record.status === 'budget-exhausted') return record
    if (record.runs.some((run) => this.isRunActive(run.status))) return record
    record.status = status
    record.endedAt = Date.now()
    await this.save(record)
    return record
  }

  /** 关闭 mission（completed/failed/cancelled）。 */
  async close(id: string, status: 'completed' | 'failed' | 'cancelled', summary?: string): Promise<MissionRecord | undefined> {
    const record = await this.get(id)
    if (!record) return undefined
    record.status = status
    record.endedAt = Date.now()
    if (summary) record.summary = summary
    await this.save(record)
    return record
  }

  /** 列出 mission（project 读目录，global 读索引指针）。 */
  async list(scope: 'project' | 'global'): Promise<MissionRecord[]> {
    if (scope === 'project') {
      const dir = this.projectDir()
      let entries: string[]
      try {
        entries = await readdir(dir)
      } catch {
        return []
      }
      const records: MissionRecord[] = []
      for (const entry of entries) {
        if (entry === 'index.json') continue
        const record = await readJsonFile<MissionRecord>(path.join(dir, entry, 'record.json'))
        if (record) records.push(record)
      }
      return records.sort((a, b) => b.updatedAt - a.updatedAt)
    }
    const file = await this.indexFile()
    const index = (await readJsonFile<Record<string, { projectRoot?: string }>>(file)) ?? {}
    const records: MissionRecord[] = []
    for (const [id, pointer] of Object.entries(index)) {
      const record = await readJsonFile<MissionRecord>(path.join(pointer.projectRoot ?? '', '.dsh', 'subagents', 'missions', id, 'record.json'))
      if (record) records.push(record)
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 清理终态记录（仅 oldest completed/failed/cancelled，保留 retainTerminal 个）。 */
  async prune(): Promise<number> {
    const retain = this.config.missions.retainTerminal ?? 200
    const records = await this.list('project')
    const terminal = records.filter((r) => r.status === 'completed' || r.status === 'failed' || r.status === 'cancelled').sort((a, b) => a.updatedAt - b.updatedAt)
    const excess = terminal.slice(0, Math.max(0, terminal.length - retain))
    let pruned = 0
    for (const record of excess) {
      try {
        await rm(this.missionDir(record.id), { recursive: true, force: true })
        pruned += 1
      } catch {
        // 忽略
      }
    }
    return pruned
  }

  /** 活跃 mission（goal driver 用）。 */
  async activeGoalMissions(): Promise<MissionRecord[]> {
    const records = await this.list('project')
    return records.filter((r) => r.goal && !r.goalPaused && (r.status === 'active' || r.status === 'planned' || r.status === 'waiting' || r.status === 'needs_decision'))
  }

  /** 该项目 mission 目录的磁盘占用（doctor 用）。 */
  async diskUsage(): Promise<number> {
    let total = 0
    const walk = async (dir: string): Promise<void> => {
      let entries: import('node:fs').Dirent[]
      try {
        entries = await readdir(dir, { withFileTypes: true }) as import('node:fs').Dirent[]
      } catch {
        return
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) await walk(full)
        else if (entry.isFile()) {
          try {
            total += (await stat(full)).size
          } catch {
            // 忽略
          }
        }
      }
    }
    await walk(this.projectDir())
    return total
  }
}
