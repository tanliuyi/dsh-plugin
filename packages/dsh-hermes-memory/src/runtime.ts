/**
 * 插件运行时依赖 — 工具/处理器/命令共享的存储与 LLM 访问。
 *
 * 与上游的差异：上游维护"单个活跃项目"（session_start 时从 cwd 检测）；
 * dsh 单进程可并行多个会话，因此项目存储按项目名惰性创建并按需解析
 * （工具从 exec.agent 的会话 cwd、命令从 invocation.agent 的会话 cwd 检测）。
 */

import type { Context } from '@deepseek-ai/cordis'
import * as path from 'node:path'
import type { MemoryConfig, MemoryTarget } from './types.ts'
import { MemoryStore } from './store/memory-store.ts'
import { ExtendedMemoryStore } from './store/extended-store.ts'
import { SkillStore } from './store/skill-store.ts'
import { StandingInstructions } from './store/standing-instructions.ts'
import { detectProject } from './project.ts'
import type { LlmLike, ModelSelection, TimerLike } from './llm.ts'

/** 项目存储集合：按项目名惰性创建 MemoryStore。 */
export class ProjectStores {
  private stores = new Map<string, { store: MemoryStore; memoryDir: string }>()

  constructor(
    private config: MemoryConfig,
    private onStoreCreated: (store: MemoryStore, projectName: string) => void,
  ) {}

  /**
   * 取（或创建）项目存储。
   * @param name - 项目名
   * @param memoryDir - 项目记忆目录
   */
  get(name: string, memoryDir: string): MemoryStore {
    const existing = this.stores.get(name)
    if (existing) return existing.store
    const store = new MemoryStore({
      ...this.config,
      memoryCharLimit: this.config.projectCharLimit,
      memoryDir,
    })
    this.stores.set(name, { store, memoryDir })
    this.onStoreCreated(store, name)
    return store
  }

  /**
   * 从工作目录解析项目及其存储。
   * @param cwd - 工作目录
   * @returns 项目名与存储；无项目时为 null
   */
  resolve(cwd?: string): { name: string | null; store: MemoryStore | null } {
    const project = detectProject(this.config.projectsMemoryDir, cwd)
    if (!project.name || !project.memoryDir) return { name: null, store: null }
    const store = this.get(project.name, project.memoryDir)
    return { name: project.name, store }
  }

  /** 全部已创建的项目存储。 */
  all(): Array<{ name: string; store: MemoryStore }> {
    return [...this.stores.entries()].map(([name, { store }]) => ({ name, store }))
  }

  /**
   * 从磁盘加载全部项目存储。
   */
  async loadAllFromDisk(): Promise<void> {
    for (const { store } of this.stores.values()) {
      await store.loadFromDisk()
    }
  }
}

/** 插件运行时依赖包。 */
export interface HermesRuntime {
  config: MemoryConfig
  store: MemoryStore
  projectStores: ProjectStores
  extended: ExtendedMemoryStore
  skillStore: SkillStore
  standing: StandingInstructions | null
  /** 项目记忆根目录。 */
  projectsRoot: string
  /** dsh llm 服务（可能缺失，调用点需判空）。 */
  llm?: LlmLike
  /** 当前默认模型选择（agentDefaultModel）。 */
  defaultModel?: () => ModelSelection | undefined
  /** timer 服务。 */
  timer?: TimerLike
}

/** 从 Cordis 上下文提取 llm 服务（结构化子集）。 */
export function llmFromCtx(ctx: Context): LlmLike | undefined {
  const llm = ctx.get('llm')
  if (llm && typeof (llm as { stream?: unknown }).stream === 'function') {
    return llm as unknown as LlmLike
  }
  return undefined
}

/** 从 Cordis 上下文提取默认模型选择。 */
export function defaultModelFromCtx(ctx: Context): (() => ModelSelection | undefined) | undefined {
  const service = ctx.get('agentDefaultModel')
  if (service && typeof (service as { currentSelection?: unknown }).currentSelection === 'function') {
    const agentDefaultModel = service as { currentSelection: () => ModelSelection }
    return () => agentDefaultModel.currentSelection()
  }
  return undefined
}

/** 从 Cordis 上下文提取 timer 服务（结构化子集）。 */
export function timerFromCtx(ctx: Context): TimerLike | undefined {
  const timer = ctx.get('timer')
  if (timer && typeof (timer as { timeout?: unknown }).timeout === 'function') {
    return timer as unknown as TimerLike
  }
  return undefined
}

/**
 * 构建运行时依赖（存储装配）。
 * @param ctx - 插件上下文
 * @param config - 配置
 * @param memoryDir - 全局记忆目录
 * @param projectsRoot - 项目记忆根目录
 * @param extended - 扩展存储
 * @param standing - 常驻指令
 * @param attachProjectStore - 项目存储装配回调（挂观察者/整合器）
 */
export function buildRuntime(
  ctx: Context,
  config: MemoryConfig,
  memoryDir: string,
  projectsRoot: string,
  extended: ExtendedMemoryStore,
  standing: StandingInstructions | null,
  attachProjectStore: (store: MemoryStore, projectName: string) => void,
): HermesRuntime {
  const store = new MemoryStore(config)
  const projectStores = new ProjectStores(config, attachProjectStore)
  const skillStore = new SkillStore({
    globalSkillsDir: path.join(memoryDir, 'skills'),
    projectsRoot,
  })
  return {
    config,
    store,
    projectStores,
    extended,
    skillStore,
    standing,
    projectsRoot,
    llm: llmFromCtx(ctx),
    defaultModel: defaultModelFromCtx(ctx),
    timer: timerFromCtx(ctx),
  }
}

/** 变异观察者工厂：把 Markdown 目标镜像进扩展存储。 */
export function makeMutationObserver(
  extended: ExtendedMemoryStore,
  projectName: string | null = null,
): (target: MemoryTarget, entries: string[]) => Promise<string | null> {
  return (target, entries) => extended.observeMutation(target, entries, projectName)
}
