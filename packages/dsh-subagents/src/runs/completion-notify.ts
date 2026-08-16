/**
 * 后台完成通知批量器（对齐上游 pi-subagents src/runs/background/completion-batcher.ts
 * 与 notify.ts 的投递语义）。
 *
 * - completed 通知进入 per-session 批：debounce 150ms、从首条起 maxWait 1s，
 *   窗口内多条合并为一条 grouped 通知；
 * - 上一批发出后 stragglerWindowMs（2s）内到达的迟到者进入 straggler 批
 *   （debounce 75ms / maxWait 400ms）；
 * - 非 completed（失败等）绕过批量：先 flush 已持有的批，再立即单独投递；
 * - 投递动作（turnOpen 判定 / withhold / followup）由调用方的 deliver 回调负责。
 */

export interface CompletionNotifyItem {
  jobId: string
  /** 单条通知文本（以 run 记录为准）。 */
  text: string
}

export interface CompletionBatchConfig {
  enabled: boolean
  debounceMs: number
  maxWaitMs: number
  stragglerDebounceMs: number
  stragglerMaxWaitMs: number
  stragglerWindowMs: number
}

export const DEFAULT_COMPLETION_BATCH_CONFIG: CompletionBatchConfig = {
  enabled: true,
  debounceMs: 150,
  maxWaitMs: 1_000,
  stragglerDebounceMs: 75,
  stragglerMaxWaitMs: 400,
  stragglerWindowMs: 2_000,
}

export interface CompletionNotifierOptions {
  /** 投递回调：sessionId + 本次发出的一组（已合并成 groupedText）。 */
  deliver(sessionId: string, items: CompletionNotifyItem[], groupedText: string): void
  timers?: { setTimeout(callback: () => void, delayMs: number): unknown; clearTimeout(handle: unknown): void }
  now?: () => number
  config?: Partial<CompletionBatchConfig>
}

interface Batch {
  items: CompletionNotifyItem[]
  timer: unknown
  firstAt: number
  straggler: boolean
}

const defaultTimers = {
  setTimeout: (callback: () => void, delayMs: number): unknown => setTimeout(callback, delayMs),
  clearTimeout: (handle: unknown): void => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** 合并文本：标题行 + 每 run 一行 + 输出尾部（对齐上游 grouped 格式的紧凑面）。 */
export function formatGroupedCompletionNotices(items: CompletionNotifyItem[]): string {
  const trunc = (value: string): string => (value.length > 300 ? `${value.slice(0, 300)}…` : value)
  const lines = [`[subagents] ${items.length} background run(s) finished:`]
  for (const item of items) {
    const [head = item.jobId, ...body] = item.text.split("\n")
    lines.push(`- ${head.replace(/^\[subagents\] /, '')}`)
    let inTail = false
    for (const line of body) {
      if (line.startsWith('Output tail:')) {
        inTail = true
        const inline = line.slice('Output tail:'.length).trim()
        if (inline) {
          lines.push(`  output: ${trunc(inline)}`)
          inTail = false
        }
        continue
      }
      if (inTail && line.trim()) {
        // 尾部内容独占一行：取第一行作为预览
        lines.push(`  output: ${trunc(line.trim())}`)
        inTail = false
        continue
      }
      if (inTail || line.startsWith('Inspect with')) inTail = false
    }
  }
  lines.push('Inspect with `subagents({ action: "status" })`, read the full result with `job_output`, or stop with `subagents({ action: "stop", id })`.')
  return lines.join('\n')
}

export class CompletionNotifier {
  private readonly batches = new Map<string, Batch>()
  private readonly lastEmitAt = new Map<string, number>()
  private readonly timers: CompletionNotifierOptions['timers'] & { setTimeout: (cb: () => void, ms: number) => unknown }
  private readonly now: () => number
  private readonly config: CompletionBatchConfig
  private readonly deliver: (sessionId: string, items: CompletionNotifyItem[], groupedText: string) => void

  constructor(options: CompletionNotifierOptions) {
    this.deliver = options.deliver
    this.timers = { ...defaultTimers, ...(options.timers ?? {}) }
    this.now = options.now ?? Date.now
    this.config = { ...DEFAULT_COMPLETION_BATCH_CONFIG, ...(options.config ?? {}) }
  }

  /**
   * 登记一条完成通知。
   * @param immediate - 非 completed（失败等）：绕过批量，先 flush 已持有的批再立即投递本条。
   */
  notify(sessionId: string, item: CompletionNotifyItem, immediate: boolean): void {
    if (immediate) {
      this.flush(sessionId)
      this.deliver(sessionId, [item], item.text)
      return
    }
    if (!this.config.enabled) {
      this.deliver(sessionId, [item], item.text)
      return
    }
    let batch = this.batches.get(sessionId)
    const now = this.now()
    if (!batch) {
      const lastEmit = this.lastEmitAt.get(sessionId)
      const straggler = lastEmit !== undefined && now - lastEmit <= this.config.stragglerWindowMs
      batch = { items: [], timer: undefined, firstAt: now, straggler }
      this.batches.set(sessionId, batch)
      const debounce = straggler ? this.config.stragglerDebounceMs : this.config.debounceMs
      const maxWait = straggler ? this.config.stragglerMaxWaitMs : this.config.maxWaitMs
      batch.timer = this.timers.setTimeout(() => this.flush(sessionId), debounce)
      // 硬上限：从首条起 maxWait 内必须发出（对齐上游 max-wait cap）
      this.timers.setTimeout(() => {
        const current = this.batches.get(sessionId)
        if (current && current.firstAt === batch!.firstAt) this.flush(sessionId)
      }, Math.max(maxWait - debounce, 1))
    }
    batch.items.push(item)
  }

  flush(sessionId: string): void {
    const batch = this.batches.get(sessionId)
    if (!batch || batch.items.length === 0) return
    this.batches.delete(sessionId)
    if (batch.timer !== undefined) this.timers.clearTimeout(batch.timer)
    this.lastEmitAt.set(sessionId, this.now())
    const items = batch.items
    this.deliver(sessionId, items, items.length === 1 ? items[0]!.text : formatGroupedCompletionNotices(items))
  }

  dispose(): void {
    for (const batch of this.batches.values()) {
      if (batch.timer !== undefined) this.timers.clearTimeout(batch.timer)
    }
    this.batches.clear()
  }
}
