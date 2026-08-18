/** Per-key monotonic epoch guard for latest-wins async catalog reloads. */

/**
 * Tracks a monotonic epoch per key. Every started operation calls `begin(key)` to
 * take the newest epoch; when it finishes it may only write its result if
 * `isCurrent(key, epoch)` still holds. A stale (superseded) operation therefore
 * never overwrites fresher data — e.g. a slow preset-A `commands/list` returning
 * after a preset-B refresh.
 */
export class KeyedEpochGuard {
  private readonly current = new Map<string, number>()

  /** Claim the next epoch for `key`; only the holder of the latest epoch may apply. */
  begin(key: string): number {
    const next = (this.current.get(key) ?? 0) + 1
    this.current.set(key, next)
    return next
  }

  /** True when `epoch` is still the newest epoch claimed for `key`. */
  isCurrent(key: string, epoch: number): boolean {
    return this.current.get(key) === epoch
  }
}
