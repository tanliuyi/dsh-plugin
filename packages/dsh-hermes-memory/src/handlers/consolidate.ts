/**
 * 自动整合 — 记忆满时触发 LLM 整合而不是报错。
 *
 * 移植自 pi-hermes-memory/src/handlers/auto-consolidate.ts（MIT）。
 *
 * 差异：上游有 direct（进程内）与 subprocess（pi -p 子进程）双传输；
 * dsh 只有进程内 direct（llm.stream）。锁由 SQLite 协调器换成进程内
 * per-target 互斥（带 heartbeat 续期与 staleMs 回收），语义保持一致：
 * 同一目标同时只允许一个整合运行，竞争时返回 deferred 而不是失败。
 */

import { createHash } from 'node:crypto'
import { DEFAULT_CONSOLIDATION_TIMEOUT_MS, DIRECT_CONSOLIDATION_SYSTEM_PROMPT, ENTRY_DELIMITER } from '../constants.ts'
import type { ConsolidationResult, MemoryConfig, MemoryTarget, ToolMemoryTarget } from '../types.ts'
import type { MemoryStore } from '../store/memory-store.ts'
import type { HermesRuntime } from '../runtime.ts'
import { runMemoryCompletion } from './llm-run.ts'

const CONSOLIDATION_LOCK_STALE_MS = 45_000
const CONSOLIDATION_LOCK_HEARTBEAT_MS = 10_000

interface ConsolidationLock {
  release: () => void
}

interface LockEntry {
  expiresAt: number
  disposers: Array<() => void>
}

/** 进程内整合锁：key → 持有条目。 */
const locks = new Map<string, LockEntry>()

function lockKey(target: MemoryTarget, toolTarget: ToolMemoryTarget, storageIdentity: string): string {
  const storageHash = createHash('sha256').update(storageIdentity).digest('hex')
  return `${toolTarget}:${target}:${storageHash}`
}

function acquireConsolidationLock(
  store: MemoryStore,
  target: MemoryTarget,
  toolTarget: ToolMemoryTarget,
  timer: { timeout(callback: () => void, delay: number): () => void } | undefined,
): Promise<{ lock: ConsolidationLock | null; contended: boolean }> {
  return (async () => {
    const storageIdentity = await store.getStorageIdentity(target)
    const key = lockKey(target, toolTarget, storageIdentity)

    const existing = locks.get(key)
    if (existing && existing.expiresAt > Date.now()) {
      return { lock: null, contended: true }
    }
    if (existing) locks.delete(key)

    const entry: LockEntry = { expiresAt: Date.now() + CONSOLIDATION_LOCK_STALE_MS, disposers: [] }
    const heartbeat = () => {
      entry.expiresAt = Date.now() + CONSOLIDATION_LOCK_STALE_MS
    }
    if (timer) {
      entry.disposers.push(timer.timeout(heartbeat, CONSOLIDATION_LOCK_HEARTBEAT_MS))
    } else {
      const handle = setInterval(heartbeat, CONSOLIDATION_LOCK_HEARTBEAT_MS)
      entry.disposers.push(() => clearInterval(handle))
    }
    locks.set(key, entry)

    return {
      lock: {
        release: () => {
          for (const dispose of entry.disposers) {
            try { dispose() } catch { /* ignore */ }
          }
          locks.delete(key)
        },
      },
      contended: false,
    }
  })()
}

function entriesForTarget(store: MemoryStore, target: MemoryTarget): string[] {
  if (target === 'user') return store.getUserEntries()
  if (target === 'failure') return store.getAllFailureEntries()
  return store.getMemoryEntries()
}

function labelForTarget(target: MemoryTarget, toolTarget: ToolMemoryTarget): string {
  if (toolTarget === 'project') return 'Project Memory'
  if (target === 'user') return 'User Profile'
  if (target === 'failure') return 'Failure Memory'
  return 'Memory'
}

/**
 * 触发一次整合（进程内 direct）。
 * @param runtime - 插件运行时
 * @param store - 目标存储
 * @param target - 目标
 * @param signal - 取消信号
 * @param timeoutMs - 超时
 * @param toolTarget - 工具视角的目标（project 时映射）
 */
export async function triggerConsolidation(
  runtime: HermesRuntime,
  store: MemoryStore,
  target: MemoryTarget,
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_CONSOLIDATION_TIMEOUT_MS,
  toolTarget: ToolMemoryTarget = target,
): Promise<ConsolidationResult> {
  const entries = entriesForTarget(store, target)
  const currentContent = entries.join(ENTRY_DELIMITER)

  if (runtime.llm) {
    try {
      const directResult = await runMemoryCompletion(
        runtime.llm,
        runtime.defaultModel,
        runtime.timer,
        store,
        toolTarget === 'project' ? store : null,
        {
          systemPrompt: DIRECT_CONSOLIDATION_SYSTEM_PROMPT,
          userPrompt: [
            `--- Current ${labelForTarget(target, toolTarget)} Entries (target: '${toolTarget}') ---`,
            currentContent || '(empty)',
            '',
            `Only emit operations with "target": "${toolTarget}".`,
          ].join('\n'),
          config: runtime.config as MemoryConfig,
          timeoutMs,
          signal,
          requireAtomicShrink: true,
          expectedTarget: toolTarget,
        },
        null,
      )
      // 整合只有在真正腾出空间时才成功 — 与 review/flush/correction 不同，
      // 空结果或全跳过在这里是失败。
      if (directResult.ok && directResult.appliedCount > 0) {
        return { consolidated: true }
      }
      if (!directResult.ok) {
        return { consolidated: false, error: directResult.error ?? directResult.fallbackReason }
      }
      return { consolidated: false, error: 'Consolidation ran but did not free enough space.' }
    } catch (error) {
      return { consolidated: false, error: `Consolidation failed: ${String(error).slice(0, 200)}` }
    }
  }

  return { consolidated: false, error: 'Consolidation unavailable: llm service is not mounted.' }
}

/**
 * 为存储装配自动整合器（内存溢出时触发）。
 * @param runtime - 插件运行时
 * @param toolTarget - 工具视角的目标（项目存储传 'project'）
 * @returns 装配函数（ProjectStores.onStoreCreated 用）
 */
export function makeAutoConsolidator(
  runtime: HermesRuntime,
  toolTarget: ToolMemoryTarget,
): (store: MemoryStore, projectName: string) => void {
  return (store) => {
    store.setConsolidator(async (target, signal) => {
      const result = await triggerConsolidation(
        runtime,
        store,
        target,
        signal,
        runtime.config.consolidationTimeoutMs,
        toolTarget === 'project' ? 'project' : target,
      )
      if (result.deferred) {
        console.info(`⏳ Auto-consolidation for '${toolTarget}' deferred: ${result.error ?? 'another session holds the consolidation lock'}`)
      } else if (!result.consolidated && runtime.config.autoConsolidationWarnOnFailure) {
        console.warn(`⚠️ Auto-consolidation failed for '${toolTarget}': ${result.error ?? 'no reason reported'}`)
      }
      return result
    })
  }
}

/**
 * 手动整合命令（/memory-consolidate）。
 * @param cwd - 命令发起会话的工作目录
 * @param runtime - 插件运行时
 */
export async function runManualConsolidation(
  cwd: string | undefined,
  runtime: HermesRuntime,
): Promise<{ kind: 'success' | 'error'; text: string }> {
  const { store, projectStores } = runtime
  const results: string[] = []
  const targets: Array<{
    label: string
    store: MemoryStore
    target: MemoryTarget
    toolTarget: ToolMemoryTarget
  }> = [
    { label: 'memory', store, target: 'memory', toolTarget: 'memory' },
    { label: 'user', store, target: 'user', toolTarget: 'user' },
    { label: 'failure', store, target: 'failure', toolTarget: 'failure' },
  ]

  const project = projectStores.resolve(cwd)
  if (project.store && project.name) {
    targets.push({
      label: `project:${project.name}`,
      store: project.store,
      target: 'memory',
      toolTarget: 'project',
    })
  }

  for (const item of targets) {
    const entries = entriesForTarget(item.store, item.target)
    if (entries.length === 0) {
      results.push(`${item.label}: (empty, nothing to consolidate)`)
      continue
    }

    let lock: ConsolidationLock | null = null
    try {
      const attempt = await acquireConsolidationLock(item.store, item.target, item.toolTarget, runtime.timer)
      lock = attempt.lock
      if (!lock) {
        results.push(`${item.label}: ⏳ consolidation already in progress elsewhere — retry shortly`)
        continue
      }
      const result = await triggerConsolidation(runtime, item.store, item.target, undefined, runtime.config.consolidationTimeoutMs, item.toolTarget)
      if (result.consolidated) {
        await item.store.loadFromDisk()
        results.push(`${item.label}: ✅ consolidated`)
      } else {
        results.push(`${item.label}: ❌ ${result.error}`)
      }
    } catch (error) {
      results.push(`${item.label}: ❌ ${String(error).slice(0, 200)}`)
    } finally {
      lock?.release()
    }
  }

  const summary = `\n  🔄 Memory Consolidation\n  ${'─'.repeat(30)}\n${results.map((r) => `  ${r}`).join('\n')}`
  return { kind: 'success', text: summary }
}
