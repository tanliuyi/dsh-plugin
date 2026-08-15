/**
 * 预算：单次运行树累计子代理上限（maxSubagentSpawnsPerRun）、会话累计上限
 * （maxSubagentSpawnsPerSession + grant）、并发顶层后台运行上限
 * （maxActiveAsyncRunsPerSession）、嵌套深度（maxSubagentDepth）。
 */

import type { SubagentsConfig } from '../types.ts'
import { DEFAULT_MAX_SPAWNS_PER_RUN } from '../types.ts'

/** 会话级 spawn 预算（上限 + grant 追加）。 */
export class SpawnBudget {
  private used = 0
  private grants = 0
  private readonly limit: number | undefined

  constructor(limit: number | undefined) {
    this.limit = limit === undefined || limit <= 0 ? undefined : limit
  }

  /** 是否允许再启动一个逻辑子代理。 */
  canSpawn(): boolean {
    if (this.limit === undefined) return true
    return this.used < this.limit + this.grants
  }

  /** 消费一个逻辑子代理名额。返回是否成功。 */
  charge(): boolean {
    if (!this.canSpawn()) return false
    this.used += 1
    return true
  }

  get usage(): { used: number; effectiveLimit: number | undefined; remaining: number | undefined; grants: number; grantAllowance: number } {
    const effectiveLimit = this.limit
    return {
      used: this.used,
      effectiveLimit,
      remaining: effectiveLimit === undefined ? undefined : Math.max(0, effectiveLimit + this.grants - this.used),
      grants: this.grants,
      grantAllowance: effectiveLimit === undefined ? 0 : Math.max(0, effectiveLimit - this.grants),
    }
  }

  /** 追加授权（root 交互式 parent 显式调用；总额不超过原上限）。 */
  grant(additional: number): { ok: boolean; error?: string } {
    if (this.limit === undefined) return { ok: false, error: 'spawn budget grants are only valid for a configured session cap' }
    const allowance = this.limit - this.grants
    if (additional > allowance) return { ok: false, error: `grant exceeds remaining allowance (${allowance})` }
    this.grants += additional
    return { ok: true }
  }
}

/** 单次运行树的累计子代理上限。 */
export class RunTreeBudget {
  private used = 0
  readonly limit: number

  constructor(configLimit: number | undefined) {
    this.limit = configLimit && configLimit > 0 ? configLimit : DEFAULT_MAX_SPAWNS_PER_RUN
  }

  canSpawn(): boolean {
    return this.used < this.limit
  }

  charge(): boolean {
    if (!this.canSpawn()) return false
    this.used += 1
    return true
  }

  get usage(): { used: number; limit: number; remaining: number } {
    return { used: this.used, limit: this.limit, remaining: this.limit - this.used }
  }
}

/** 会话级并发顶层后台运行上限。 */
export class ActiveAsyncCapacity {
  private active = 0
  private readonly limit: number | undefined

  constructor(limit: number | undefined) {
    this.limit = limit === undefined || limit <= 0 ? undefined : limit
  }

  canStart(): boolean {
    return this.limit === undefined || this.active < this.limit
  }

  reserve(): boolean {
    if (!this.canStart()) return false
    this.active += 1
    return true
  }

  release(): void {
    this.active = Math.max(0, this.active - 1)
  }

  get usage(): { used: number; effectiveLimit: number | undefined; remaining: number | undefined } {
    return {
      used: this.active,
      effectiveLimit: this.limit,
      remaining: this.limit === undefined ? undefined : Math.max(0, this.limit - this.active),
    }
  }
}

/** 会话级预算集合。 */
export class SessionBudgets {
  readonly spawns: SpawnBudget
  readonly asyncCapacity: ActiveAsyncCapacity

  constructor(config: SubagentsConfig) {
    this.spawns = new SpawnBudget(config.maxSubagentSpawnsPerSession)
    this.asyncCapacity = new ActiveAsyncCapacity(config.maxActiveAsyncRunsPerSession)
  }
}

/** 当前调用方的嵌套深度上限校验。 */
export function depthError(currentDepth: number, maxDepth: number): string | undefined {
  if (currentDepth >= maxDepth) {
    return `subagent delegation depth limit reached (max ${maxDepth}); complete the current task directly instead of launching more subagents`
  }
  return undefined
}
