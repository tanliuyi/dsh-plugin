/**
 * 运行存储：当前会话的运行记录（内存）+ 磁盘产物（status.json / events.jsonl /
 * output-<n>.log，对齐 pi-subagents 的 async 产物形状）。
 */

import { mkdir, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ChildRecord, Details, FleetEntry, RetainedChild, ResultRow, RunRecord, RunState } from '../types.ts'
import { DIRS, MAX_RETAINED_CHILDREN } from '../types.ts'
import { writeJsonAtomic } from '../util.ts'

/** RunStore 的构造选项。 */
export interface RunStoreOptions {
  sessionId: string
  cwd: string
  /** 磁盘产物写入失败时的诊断回调（缺省静默；生产由插件日志接线）。 */
  logger?: (message: string) => void
}

/** 运行存储：当前会话的运行记录（内存）+ 磁盘产物（status.json / events.jsonl / output-<n>.log）。 */
export class RunStore {
  private readonly runs = new Map<string, RunRecord>()
  private readonly childAgents = new Map<string, ChildRecord>() // runId → child
  private readonly retained = new Map<string, RetainedChild[]>() // sessionId → list
  private readonly logger?: (message: string) => void
  readonly sessionId: string
  readonly cwd: string

  constructor(options: RunStoreOptions) {
    this.sessionId = options.sessionId
    this.cwd = options.cwd
    this.logger = options.logger
  }

  /** 创建一条运行记录（内存）。 */
  createRun(input: {
    mode: 'single' | 'workflow'
    agent: string
    goal?: string
    missionId?: string
    timeoutMs?: number
  }): RunRecord {
    const record: RunRecord = {
      id: randomUUID().slice(0, 12),
      mode: input.mode,
      state: 'running',
      agent: input.agent,
      goal: input.goal,
      cwd: this.cwd,
      sessionId: this.sessionId,
      missionId: input.missionId,
      startedAt: Date.now(),
      lastUpdate: Date.now(),
      timeoutMs: input.timeoutMs,
      children: [],
      results: [],
      spawnCount: 0,
      usage: {},
      active: true,
    }
    this.runs.set(record.id, record)
    return record
  }

  /** 按 id 读取记录。 */
  get(id: string): RunRecord | undefined {
    return this.runs.get(id)
  }

  /** 按 id 前缀匹配（status 的宽松解析）。 */
  find(prefix: string): RunRecord | undefined {
    if (this.runs.has(prefix)) return this.runs.get(prefix)
    for (const [id, run] of this.runs) {
      if (id.startsWith(prefix)) return run
    }
    return undefined
  }

  /** 当前会话全部记录（按启动时间倒序）。 */
  list(): RunRecord[] {
    return [...this.runs.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  /** 仍活跃（未终结）的运行。 */
  activeRuns(): RunRecord[] {
    return this.list().filter((run) => run.active)
  }

  /** 追加一个子代理记录。 */
  addChild(runId: string, child: ChildRecord): void {
    const run = this.runs.get(runId)
    if (!run) return
    run.children.push(child)
    run.spawnCount += 1
    run.lastUpdate = Date.now()
    if (child.runId) this.childAgents.set(child.runId, child)
    this.persist(run)
  }

  /** 更新子代理记录（runId 在启动解析后写入并登记索引）。 */
  updateChild(runId: string, childIndex: number, patch: Partial<ChildRecord>): void {
    const run = this.runs.get(runId)
    if (!run) return
    const child = run.children.find((c) => c.index === childIndex)
    if (!child) return
    Object.assign(child, patch)
    // runId 在启动解析后才写入：此时才登记 runId → child 索引
    if (child.runId) this.childAgents.set(child.runId, child)
    run.lastUpdate = Date.now()
    this.persist(run)
  }

  /** 终结一个子代理记录并累计用量。 */
  finishChild(runId: string, childIndex: number, patch: Partial<ChildRecord>): void {
    const run = this.runs.get(runId)
    if (!run) return
    const child = run.children.find((c) => c.index === childIndex)
    if (!child) return
    Object.assign(child, { endedAt: Date.now(), ...patch })
    run.lastUpdate = Date.now()
    run.totalTokens = (run.totalTokens ?? 0) + (child.totalTokens ?? 0)
    run.totalCost = (run.totalCost ?? 0) + (child.totalCost ?? 0)
    this.persist(run)
  }

  /** 汇总 results 并终结运行。 */
  finishRun(runId: string, state: RunState, extra: Partial<RunRecord> = {}): RunRecord | undefined {
    const run = this.runs.get(runId)
    if (!run) return undefined
    run.state = state
    run.active = false
    run.endedAt = Date.now()
    run.durationMs = run.endedAt - run.startedAt
    Object.assign(run, extra)
    run.results = run.children.map((child): ResultRow => ({
      index: child.index,
      key: child.key,
      runId: child.runId,
      agent: child.agent,
      task: child.task,
      status: child.status,
      exitCode: child.status === 'completed' ? 0 : 1,
      startedAt: child.startedAt,
      endedAt: child.endedAt,
      output: child.output,
      outputFile: child.outputFile,
      sessionFile: child.sessionFile,
      model: child.model,
      toolCount: child.toolCount,
      turnCount: child.turnCount,
      totalTokens: child.totalTokens,
      totalCost: child.totalCost,
      stopReason: child.stopReason,
      evidenceStatus: child.evidenceStatus,
      resumable: child.resumable,
      missionId: run.missionId,
    }))
    this.persist(run)
    this.retainCompletedChildren(run)
    return run
  }

  /** 保留完成子代理（最多 MAX_RETAINED_CHILDREN 个，resume 目标）。 */
  private retainCompletedChildren(run: RunRecord): void {
    const list = this.retained.get(this.sessionId) ?? []
    for (const child of run.children) {
      if (child.status === 'completed' || child.status === 'failed' || child.status === 'stopped') {
        list.push({
          runId: child.runId ?? `${run.id}-${child.index}`,
          index: child.index,
          agent: child.agent,
          key: child.key,
          task: child.task,
          output: child.output ?? '',
          resumable: true,
          reason: child.status === 'completed' ? undefined : `previous attempt ${child.status}`,
          missionId: run.missionId,
        })
      }
    }
    const trimmed = list.slice(-MAX_RETAINED_CHILDREN)
    this.retained.set(this.sessionId, trimmed)
  }

  /** 会话的可 resume 子代理列表。 */
  retainedChildren(sessionId: string): RetainedChild[] {
    return this.retained.get(sessionId) ?? []
  }

  /** 按子代理 runId 反查 child 记录（supervisor 归属查询用）。 */
  childByRunId(childRunId: string): ChildRecord | undefined {
    return this.childAgents.get(childRunId)
  }

  /** 某父会话名下全部子代理记录。 */
  childrenOfParent(parentSessionId: string): ChildRecord[] {
    const out: ChildRecord[] = []
    for (const run of this.runs.values()) {
      if (run.sessionId !== parentSessionId) continue
      for (const child of run.children) out.push(child)
    }
    return out
  }

  /** 运行产物目录。 */
  async asyncDir(runId: string): Promise<string> {
    const dir = path.join(DIRS.async, this.sessionId, runId)
    await mkdir(dir, { recursive: true })
    return dir
  }

  /** 写 status.json 投影。 */
  persist(run: RunRecord): void {
    void this.persistAsync(run)
  }

  private async persistAsync(run: RunRecord): Promise<void> {
    try {
      const dir = await this.asyncDir(run.id)
      const { children, ...rest } = run
      void children
      await writeJsonAtomic(path.join(dir, 'status.json'), {
        lifecycleArtifactVersion: 3,
        ...rest,
        childSummaries: children.map(({ index, key, runId, agent, task, status, startedAt, endedAt, totalTokens, totalCost }) => ({
          index, key, runId, agent, task, status, startedAt, endedAt, totalTokens, totalCost,
        })),
      })
    } catch (error) {
      // 产物写入是尽力而为；失败经诊断回调上报而不是静默
      this.logger?.(`[dsh-subagents] status.json write failed for run ${run.id}: ${String(error)}`)
    }
  }

  /** 追加一条运行事件（events.jsonl）。 */
  appendEvent(runId: string, event: Record<string, unknown>): void {
    void this.appendEventAsync(runId, event)
  }

  private async appendEventAsync(runId: string, event: Record<string, unknown>): Promise<void> {
    try {
      const dir = await this.asyncDir(runId)
      const line = JSON.stringify({ ts: Date.now(), ...event })
      await writeFile(path.join(dir, 'events.jsonl'), `${line}\n`, { flag: 'a' })
    } catch (error) {
      this.logger?.(`[dsh-subagents] events.jsonl append failed for run ${runId}: ${String(error)}`)
    }
  }

  /** 追加子代理输出（output-<index>.log）。 */
  appendOutput(runId: string, index: number, text: string): void {
    void this.appendOutputAsync(runId, index, text)
  }

  private async appendOutputAsync(runId: string, index: number, text: string): Promise<void> {
    try {
      const dir = await this.asyncDir(runId)
      await writeFile(path.join(dir, `output-${index}.log`), text, { flag: 'a' })
    } catch (error) {
      this.logger?.(`[dsh-subagents] output-${index}.log append failed for run ${runId}: ${String(error)}`)
    }
  }

  /** 状态文本视图用的 fleet 条目。 */
  fleetEntries(): FleetEntry[] {
    const out: FleetEntry[] = []
    for (const run of this.activeRuns()) {
      for (const child of run.children) {
        if (child.status === 'queued' || child.status === 'running') {
          out.push({
            agent: child.agent,
            state: child.status,
            elapsedMs: Date.now() - child.startedAt,
            tokens: child.totalTokens,
            goal: run.goal,
          })
        }
      }
    }
    return out
  }

  /** 生成 Details.results（终态行）。 */
  detailsOf(run: RunRecord): Details {
    return {
      kind: run.mode,
      runId: run.id,
      mode: run.mode,
      state: run.state,
      agent: run.agent,
      results: run.results,
      totalTokens: run.totalTokens,
      totalCost: run.totalCost,
      missionId: run.missionId,
      asyncDir: undefined,
    }
  }
}
