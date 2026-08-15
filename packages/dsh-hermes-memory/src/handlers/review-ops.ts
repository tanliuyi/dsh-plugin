/**
 * Review 记忆操作 — 解析并应用结构化记忆操作（review/flush/correction/consolidation
 * 共用）。移植自 pi-hermes-memory/src/handlers/review-memory-ops.ts（MIT）。
 */

import type { MemoryStore } from '../store/memory-store.ts'
import type { MemoryCategory, MemoryResult } from '../types.ts'
import { extractJsonPayload } from '../llm.ts'

export interface ReviewMemoryOperation {
  action: 'add' | 'replace' | 'remove'
  target: 'memory' | 'user' | 'project' | 'failure'
  content?: string
  old_text?: string
  category?: MemoryCategory
  failure_reason?: string
}

export interface ApplyReviewOperationsResult {
  appliedCount: number
  skippedCount: number
  error?: string
}

function isMemoryCategory(value: unknown): value is MemoryCategory {
  return value === 'failure'
    || value === 'correction'
    || value === 'insight'
    || value === 'preference'
    || value === 'convention'
    || value === 'tool-quirk'
}

function isReviewTarget(value: unknown): value is ReviewMemoryOperation['target'] {
  return value === 'memory' || value === 'user' || value === 'project' || value === 'failure'
}

function isReviewAction(value: unknown): value is ReviewMemoryOperation['action'] {
  return value === 'add' || value === 'replace' || value === 'remove'
}

/**
 * 解析模型返回的 operations JSON 文本。
 * @param text - 模型输出
 * @returns 操作列表；"nothing to save" 时返回空数组；无法解析时返回 null
 */
export function parseReviewOperations(text: string): ReviewMemoryOperation[] | null {
  if (/nothing to save/i.test(text) && !text.includes('{')) {
    return []
  }

  const payload = extractJsonPayload(text)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return null
  }

  const operations = (payload as { operations?: unknown }).operations
  if (!Array.isArray(operations)) return null

  const parsed: ReviewMemoryOperation[] = []
  for (const item of operations) {
    if (!item || typeof item !== 'object') continue
    const op = item as Record<string, unknown>
    if (!isReviewAction(op.action) || !isReviewTarget(op.target)) continue

    const operation: ReviewMemoryOperation = {
      action: op.action,
      target: op.target,
    }
    if (typeof op.content === 'string') operation.content = op.content
    if (typeof op.old_text === 'string') operation.old_text = op.old_text
    if (isMemoryCategory(op.category)) operation.category = op.category
    if (typeof op.failure_reason === 'string') operation.failure_reason = op.failure_reason
    parsed.push(operation)
  }

  return parsed
}

export interface ApplyReviewOperationsOptions {
  requireAtomicShrink?: boolean
  expectedTarget?: ReviewMemoryOperation['target']
}

/**
 * 应用一组记忆操作。
 * @param store - 全局存储
 * @param projectStore - 项目存储（可 null）
 * @param operations - 操作列表
 * @param projectName - 当前项目名
 * @param options - requireAtomicShrink 时要求单目标原子计划且必须缩小
 */
export async function applyReviewOperations(
  store: MemoryStore,
  projectStore: MemoryStore | null,
  operations: ReviewMemoryOperation[],
  projectName?: string | null,
  options: ApplyReviewOperationsOptions = {},
): Promise<ApplyReviewOperationsResult> {
  if (options.requireAtomicShrink) {
    if (operations.length === 0) {
      return {
        appliedCount: 0,
        skippedCount: 0,
        error: 'Atomic plan requires at least one operation.',
      }
    }

    const target = operations[0]?.target
    if (!target || operations.some((operation) => operation.target !== target)) {
      return {
        appliedCount: 0,
        skippedCount: operations.length,
        error: 'Atomic plan must use exactly one target.',
      }
    }
    if (options.expectedTarget && target !== options.expectedTarget) {
      return {
        appliedCount: 0,
        skippedCount: operations.length,
        error: `Atomic plan targeted '${target}', expected '${options.expectedTarget}'.`,
      }
    }
    if (target === 'project' && !projectStore) {
      return {
        appliedCount: 0,
        skippedCount: operations.length,
        error: 'Project memory is unavailable.',
      }
    }

    const activeStore = target === 'project' ? projectStore! : store
    const memoryTarget = target === 'project' ? 'memory' : target
    const mutationOperations = operations.map((operation) => ({
      action: operation.action,
      content: operation.content,
      oldText: operation.old_text,
      category: target === 'failure' ? operation.category ?? 'failure' : operation.category,
      failureReason: operation.failure_reason,
      project: target === 'failure' ? projectName ?? undefined : undefined,
    }))
    const result = await activeStore.applyMutationPlan(memoryTarget, mutationOperations, { requireShrink: true })
    return result.success
      ? { appliedCount: operations.length, skippedCount: 0 }
      : {
          appliedCount: 0,
          skippedCount: operations.length,
          error: result.error ?? 'Atomic memory plan failed.',
        }
  }

  let appliedCount = 0
  let skippedCount = 0

  for (const op of operations) {
    if (op.target === 'project' && !projectStore) {
      skippedCount++
      continue
    }

    const rawTarget = op.target
    const memoryTarget = rawTarget === 'project' ? 'memory' : rawTarget === 'failure' ? 'failure' : rawTarget
    const activeStore = rawTarget === 'project' ? projectStore! : store

    let result: MemoryResult
    switch (op.action) {
      case 'add': {
        if (!op.content?.trim()) {
          skippedCount++
          continue
        }
        if (rawTarget === 'failure') {
          const category = op.category ?? 'failure'
          result = await activeStore.addFailure(op.content, {
            category,
            failureReason: op.failure_reason,
            project: projectName ?? undefined,
          })
          if (result.success) {
            appliedCount++
          } else {
            skippedCount++
          }
        } else {
          result = await activeStore.add(memoryTarget, op.content)
          if (result.success) {
            appliedCount++
          } else {
            skippedCount++
          }
        }
        break
      }
      case 'replace': {
        if (!op.old_text || !op.content?.trim()) {
          skippedCount++
          continue
        }
        result = await activeStore.replace(memoryTarget, op.old_text, op.content)
        if (result.success) {
          appliedCount++
        } else {
          skippedCount++
        }
        break
      }
      case 'remove': {
        if (!op.old_text) {
          skippedCount++
          continue
        }
        result = await activeStore.remove(memoryTarget, op.old_text)
        if (result.success) {
          appliedCount++
        } else {
          skippedCount++
        }
        break
      }
      default:
        skippedCount++
        continue
    }
  }

  return { appliedCount, skippedCount }
}
