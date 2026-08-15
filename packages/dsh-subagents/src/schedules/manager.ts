/**
 * 持久化调度：<storeRoot>/<project-hash>/<id>/ 下保存定义、事件、回执。
 * 支持 `at: "+10m" | ISO` 一次性与 `every: "6h"` 固定间隔；overlap 固定
 * skip，catchUp 支持 latest/none。到点后通过 onFire 回调以后台方式启动。
 */

import { mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import * as path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { SubagentsConfig } from '../types.ts'
import { SCHEDULE_HISTORY_KEEP, SCHEDULE_TICKER_INTERVAL_MS } from '../types.ts'

import { expandTilde, projectHash, readJsonFile, readTextFile, resolvePath, writeJsonAtomic, writeTextAtomic } from '../util.ts'

/** 调度定义（持久化到 <storeRoot>/<project-hash>/<id>/definition.json）。 */
export interface ScheduleDefinition {
  id: string
  name: string
  workflowScript: string
  at?: string
  every?: string
  catchUp: 'latest' | 'none'
  paused: boolean
  createdAt: number
  plannedAt?: number
  lastRunAt?: number
  nextRunAt?: number
  runCount: number
  /** 创建者会话（到点后找它作为 parent agent）。 */
  creatorSessionId?: string
  cwd?: string
}

/** 一次调度触发的运行回执（receipts.json 条目）。 */
export interface ScheduleRunReceipt {
  runId: string
  startedAt: number
  status: string
}

/** ScheduleManager 的构造依赖。 */
export interface ScheduleManagerDeps {
  config: SubagentsConfig
  projectRoot: string
  onFire: (definition: ScheduleDefinition, runId: string) => Promise<void>
}

/** 解析 `30m`/`6h`/`2d`/`1w` 形式的间隔。 */
export function parseEveryInterval(interval: string): { ms: number; error?: string } {
  const match = interval.trim().match(/^(\d+)([mhdw])$/)
  if (!match || !match[1] || !match[2]) return { ms: 0, error: `invalid interval "${interval}" (use e.g. 30m, 6h, 2d, 1w)` }
  const value = Number(match[1])
  const unit = match[2]
  const ms = value * (unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : unit === 'd' ? 86_400_000 : 604_800_000)
  if (!Number.isSafeInteger(ms) || ms <= 0) return { ms: 0, error: `invalid interval "${interval}"` }
  return { ms }
}

/** 解析 `at` 触发点：`+10m` 相对延迟或 ISO 时间戳。 */
export function parseAtTrigger(at: string): { plannedAt: number; error?: string } {
  const trimmed = at.trim()
  if (trimmed.startsWith('+')) {
    const { ms, error } = parseEveryInterval(trimmed.slice(1))
    if (error) return { plannedAt: 0, error }
    return { plannedAt: Date.now() + ms }
  }
  const parsed = Date.parse(trimmed)
  if (!Number.isFinite(parsed)) return { plannedAt: 0, error: `invalid at "${at}" (use a relative delay like +10m or an ISO timestamp)` }
  return { plannedAt: parsed }
}

/** 持久化调度：到期触发 onFire，支持一次性与固定间隔，overlap 固定跳过。 */
export class ScheduleManager {
  private readonly deps: ScheduleManagerDeps
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  private ticker: ReturnType<typeof setInterval> | undefined

  constructor(deps: ScheduleManagerDeps) {
    this.deps = deps
  }

  private storeRoot(): string {
    const configured = this.deps.config.scheduledRuns.storeRoot
    if (configured) {
      const expanded = expandTilde(configured)
      return path.isAbsolute(expanded) ? expanded : resolvePath(expanded, this.deps.projectRoot)
    }
    return path.join(this.deps.projectRoot, '.dsh', 'subagents', 'schedules')
  }

  private projectDir(): string {
    return path.join(this.storeRoot(), projectHash(this.deps.projectRoot))
  }

  private scheduleDir(id: string): string {
    return path.join(this.projectDir(), id)
  }

  private definitionFile(id: string): string {
    return path.join(this.scheduleDir(id), 'definition.json')
  }

  private eventsFile(id: string): string {
    return path.join(this.scheduleDir(id), 'events.jsonl')
  }

  private receiptsFile(id: string): string {
    return path.join(this.scheduleDir(id), 'receipts.json')
  }

  /** 加载持久化定义并启动 ticker（经 timer 服务注册，随 fiber 自动回收）。 */
  async start(): Promise<void> {
    await this.loadAll()
    this.ticker = setInterval(() => void this.tick(), SCHEDULE_TICKER_INTERVAL_MS)
    this.ticker.unref?.()
  }

  /** 停止 ticker 与全部调度定时器（幂等）。 */
  stop(): void {
    if (this.ticker) {
      clearInterval(this.ticker)
      this.ticker = undefined
    }
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
  }

  private async appendEvent(id: string, event: Record<string, unknown>): Promise<void> {
    const dir = this.scheduleDir(id)
    await mkdir(dir, { recursive: true })
    await writeFile(this.eventsFile(id), `${JSON.stringify({ ts: Date.now(), ...event })}\n`, { flag: 'a' })
  }

  private async loadAll(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.projectDir())
    } catch {
      return
    }
    for (const entry of entries) {
      const definition = await readJsonFile<ScheduleDefinition>(this.definitionFile(entry))
      if (definition) this.arm(definition)
    }
  }

  private arm(definition: ScheduleDefinition): void {
    const existing = this.timers.get(definition.id)
    if (existing) clearTimeout(existing)
    if (definition.paused) return
    const next = definition.nextRunAt ?? definition.plannedAt
    if (next === undefined) return
    const delay = Math.max(0, next - Date.now())
    if (delay > 2_147_483_647) return // 超出 timer 范围，靠 tick 兜底
    const timer = setTimeout(() => void this.fire(definition), delay)
    timer.unref?.()
    this.timers.set(definition.id, timer)
  }

  private async tick(): Promise<void> {
    const definitions = await this.list()
    for (const definition of definitions) {
      if (definition.paused) continue
      const target = definition.nextRunAt ?? definition.plannedAt
      if (target !== undefined && target <= Date.now()) await this.fire(definition)
    }
  }

  private async fire(definition: ScheduleDefinition): Promise<string | undefined> {
    // overlap: skip（若上一次仍在跑，直接跳过一次触发）
    if (this.inflight.has(definition.id)) return undefined
    const receipt = await readJsonFile<ScheduleRunReceipt[]>(this.receiptsFile(definition.id))
    const lastReceipt = receipt?.at(-1)
    if (lastReceipt && lastReceipt.status === 'running') return undefined

    const runId = randomUUID().slice(0, 12)
    this.inflight.add(definition.id)
    const definitionCopy = { ...definition, lastRunAt: Date.now(), runCount: definition.runCount + 1 }
    try {
      // 先落 running 回执，再触发 onFire（onFire 完成后会把回执终态化；
      // 顺序颠倒会把终态覆盖回 running）
      const receipts = (await readJsonFile<ScheduleRunReceipt[]>(this.receiptsFile(definition.id))) ?? []
      receipts.push({ runId, startedAt: Date.now(), status: 'running' })
      await writeJsonAtomic(this.receiptsFile(definition.id), receipts.slice(-SCHEDULE_HISTORY_KEEP))
      await this.deps.onFire(definitionCopy, runId)
      definitionCopy.lastRunAt = Date.now()
    } finally {
      this.inflight.delete(definition.id)
      await this.appendEvent(definition.id, { type: 'schedule.fired', runId, name: definition.name })
    }

    // 推进 nextRunAt（every）或归档（at）
    if (definition.every) {
      const { ms } = parseEveryInterval(definition.every)
      if (ms > 0) {
        const anchor = definition.nextRunAt ?? definition.plannedAt ?? Date.now()
        if (this.deps.config.scheduledRuns.enabled) {
          definitionCopy.nextRunAt = anchor + ms
          await this.save(definitionCopy)
          this.arm(definitionCopy)
        }
      }
    } else {
      definitionCopy.nextRunAt = undefined
      definitionCopy.paused = true // 一次性调度触发后暂停
      await this.save(definitionCopy)
    }
    return runId
  }

  private readonly inflight = new Set<string>()

  /** 创建一条调度（at 或 every 至少其一），持久化并 arm 定时器。 */
  async create(input: { id?: string; name: string; workflowScript: string; at?: string; every?: string; catchUp?: 'latest' | 'none'; creatorSessionId?: string; cwd?: string }): Promise<{ definition: ScheduleDefinition; error?: string }> {
    if (!input.workflowScript.trim()) return { definition: undefined as never, error: 'schedule.create requires workflowScript' }
    let plannedAt: number | undefined
    let everyMs: number | undefined
    if (input.at) {
      const parsed = parseAtTrigger(input.at)
      if (parsed.error) return { definition: undefined as never, error: parsed.error }
      plannedAt = parsed.plannedAt
    }
    if (input.every) {
      const parsed = parseEveryInterval(input.every)
      if (parsed.error) return { definition: undefined as never, error: parsed.error }
      everyMs = parsed.ms
    }
    if (plannedAt === undefined && everyMs === undefined) return { definition: undefined as never, error: 'schedule.create requires at or every' }
    const id = input.id ?? randomUUID().slice(0, 12)
    const pending = (await this.list()).length
    if (pending >= (this.deps.config.scheduledRuns.maxPending ?? 20)) {
      return { definition: undefined as never, error: `pending schedule limit reached (${pending})` }
    }
    const now = Date.now()
    const definition: ScheduleDefinition = {
      id,
      name: input.name || id,
      workflowScript: input.workflowScript,
      at: input.at,
      every: input.every,
      catchUp: input.catchUp ?? 'latest',
      paused: false,
      createdAt: now,
      plannedAt: plannedAt ?? now + (everyMs ?? 0),
      nextRunAt: plannedAt ?? now + (everyMs ?? 0),
      runCount: 0,
      creatorSessionId: input.creatorSessionId,
      cwd: input.cwd,
    }
    await this.save(definition)
    await this.appendEvent(id, { type: 'schedule.created', name: definition.name })
    this.arm(definition)
    return { definition }
  }

  /** 持久化定义（原子写）。 */
  async save(definition: ScheduleDefinition): Promise<void> {
    const dir = this.scheduleDir(definition.id)
    await mkdir(dir, { recursive: true })
    await writeJsonAtomic(this.definitionFile(definition.id), definition)
  }

  /** 按 id 读取定义。 */
  async get(id: string): Promise<ScheduleDefinition | undefined> {
    return readJsonFile<ScheduleDefinition>(this.definitionFile(id))
  }

  /** 全部定义（按下次触发时间排序）。 */
  async list(): Promise<ScheduleDefinition[]> {
    let entries: string[]
    try {
      entries = await readdir(this.projectDir())
    } catch {
      return []
    }
    const out: ScheduleDefinition[] = []
    for (const entry of entries) {
      const definition = await readJsonFile<ScheduleDefinition>(this.definitionFile(entry))
      if (definition) out.push(definition)
    }
    return out.sort((a, b) => (a.nextRunAt ?? 0) - (b.nextRunAt ?? 0))
  }

  /** 事件历史（最近 SCHEDULE_HISTORY_KEEP 条）。 */
  async history(id: string): Promise<string[]> {
    const raw = await readTextFile(this.eventsFile(id))
    if (!raw) return []
    return raw.split('\n').filter(Boolean).slice(-SCHEDULE_HISTORY_KEEP)
  }

  /** 暂停：持久化 paused 并清除未触发的定时器。 */
  async pause(id: string): Promise<{ ok: boolean; error?: string }> {
    const definition = await this.get(id)
    if (!definition) return { ok: false, error: `schedule ${id} not found` }
    definition.paused = true
    await this.save(definition)
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
    return { ok: true }
  }

  /** 恢复：解除 paused 并重新 arm。 */
  async resume(id: string): Promise<{ ok: boolean; error?: string }> {
    const definition = await this.get(id)
    if (!definition) return { ok: false, error: `schedule ${id} not found` }
    definition.paused = false
    if (definition.every && definition.nextRunAt === undefined) definition.nextRunAt = Date.now()
    await this.save(definition)
    this.arm(definition)
    return { ok: true }
  }

  /** 回执终态化：workflow 完成后由 onFire 回调调用，否则 overlap-skip 会永久阻塞。 */
  async markRunTerminal(id: string, runId: string, status: 'completed' | 'failed' | 'killed'): Promise<void> {
    const receipts = (await readJsonFile<ScheduleRunReceipt[]>(this.receiptsFile(id))) ?? []
    const entry = receipts.find((receipt) => receipt.runId === runId)
    if (entry) entry.status = status
    await writeJsonAtomic(this.receiptsFile(id), receipts.slice(-SCHEDULE_HISTORY_KEEP))
  }

  /** 立即触发一次（runNow）。 */
  async runNow(id: string): Promise<{ ok: boolean; error?: string; runId?: string }> {
    const definition = await this.get(id)
    if (!definition) return { ok: false, error: `schedule ${id} not found` }
    if (definition.paused) return { ok: false, error: `schedule ${id} is paused` }
    const runId = await this.fire(definition)
    return { ok: runId !== undefined, runId }
  }

  /** 删除调度（含磁盘目录与未触发定时器）。 */
  async delete(id: string): Promise<{ ok: boolean; error?: string }> {
    const timer = this.timers.get(id)
    if (timer) clearTimeout(timer)
    this.timers.delete(id)
    try {
      await rm(this.scheduleDir(id), { recursive: true, force: true })
    } catch (error) {
      return { ok: false, error: String(error) }
    }
    return { ok: true }
  }

  /** run-due：外部启动器查询并触发到期工作。返回启动的 runId 列表。 */
  async runDue(): Promise<string[]> {
    const started: string[] = []
    const definitions = await this.list()
    for (const definition of definitions) {
      if (definition.paused) continue
      const due = definition.nextRunAt !== undefined && definition.nextRunAt <= Date.now()
      if (due) {
        const result = await this.runNow(definition.id)
        if (result.ok && result.runId) started.push(result.runId)
      }
    }
    return started
  }
}
