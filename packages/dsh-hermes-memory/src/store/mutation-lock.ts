/**
 * 进程内变异锁 — 替代上游基于 SQLite 的 AtomicLockCoordinator。
 *
 * 上游用跨进程文件锁协调多个 Pi 会话；dsh 单进程模型下用进程内 FIFO 互斥即可。
 * 语义保持一致：同一存储身份（规范路径）上的记忆变异串行执行，绝不并发写盘。
 */

/** key → 当前链尾（前一个持有者完成后 resolve）。 */
const queues = new Map<string, Promise<void>>()

/**
 * 在规范路径上串行执行记忆变异。
 * @param filePath - 目标文件路径（用于锁身份）
 * @param operation - 变异操作
 * @returns 操作结果
 */
export async function withMarkdownMutationLock<T>(filePath: string, operation: () => Promise<T> | T): Promise<T> {
  const key = `mutation:${filePath}`
  const prev = queues.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  // 链尾 = 前一个 gate 之后接上我们的 gate（吞掉前一个的 rejection）。
  const tail = prev.then(() => gate, () => gate)
  queues.set(key, tail)

  await prev.catch(() => {})
  try {
    return await operation()
  } finally {
    release()
    // 只有当我们仍是链尾时才清理条目，避免泄漏。
    queueMicrotask(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
  }
}
