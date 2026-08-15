/**
 * dsh-hermes-memory — pi-hermes-memory（MIT，chandra447/pi-hermes-memory）的 dsh 移植。
 *
 * 给 dsh 带来 Hermes 风格持久记忆与学习循环：
 * 1. 持久记忆 — MEMORY.md + USER.md + failures.md + 项目记忆，跨会话存活
 * 2. 记忆工具 — memory_add / memory_replace / memory_remove / memory_search
 * 3. 会话搜索 — session_search（复用 dsh 的 sessionQuery 全文索引）
 * 4. 程序性技能 — skill_manage（SKILL.md 文件 + dsh 技能注册表提供者）
 * 5. 后台学习循环 — 每 N 轮（或 N 次工具调用）自动 review 保存
 * 6. 纠正检测 — 用户纠正时立即保存
 * 7. 自动整合 — 记忆满时 LLM 合并条目而不是报错
 * 8. 会话 flush — 压缩/结束时保存值得记住的内容
 * 9. 机密扫描 — API key / token 被阻止持久化
 * 10. 常驻指令 — /memory-pin 注入每个会话
 * 11. 命令 — /memory-insights 等 10 个斜杠命令
 * 12. 上下文围栏 — <memory-context> 标签防止存储记忆被当作指令
 */

import type { Context } from '@deepseek-ai/cordis'
import * as path from 'node:path'
import { Config as ConfigSchema, normalizeConfig } from './config.ts'
import { STANDING_FILE } from './constants.ts'
import { resolveMemoryRoot, resolveProjectsRoot } from './paths.ts'
import { MemoryStore } from './store/memory-store.ts'
import { ExtendedMemoryStore } from './store/extended-store.ts'
import { StandingInstructions } from './store/standing-instructions.ts'
import { buildRuntime, makeMutationObserver } from './runtime.ts'
import { makeAutoConsolidator } from './handlers/consolidate.ts'
import { registerMemoryTools } from './tools/memory-tool.ts'
import { registerMemorySearchTool } from './tools/memory-search-tool.ts'
import { registerSessionSearchTool } from './tools/session-search-tool.ts'
import { registerSkillTool } from './tools/skill-tool.ts'
import { registerSkillProvider } from './skill-provider.ts'
import { setupBackgroundReview } from './handlers/review.ts'
import { setupCorrectionDetector } from './handlers/correction-detector.ts'
import { setupSessionFlush } from './handlers/flush.ts'
import { registerCommands } from './handlers/commands.ts'
import { registerPromptSections } from './context.ts'

/** 插件名。 */
export const name = 'dsh-hermes-memory'

/** 插件依赖：等待工具注册表就绪。 */
export const inject = ['tools']

/** 插件配置 Schema（加载时校验并填充默认值）。 */
export const Config = ConfigSchema
/** 插件配置类型。 */
export type Config = import('./config.ts').Config

/**
 * 插件入口：装配存储、注册工具/命令/处理器/提示词段。
 * @param ctx - 插件上下文
 * @param rawConfig - 插件配置
 */
export async function apply(ctx: Context, rawConfig: Config): Promise<void> {
  const config = normalizeConfig(rawConfig)
  const memoryDir = resolveMemoryRoot(config.memoryDir)
  const projectsRoot = resolveProjectsRoot(config.projectsMemoryDir)

  // ── 扩展存储（搜索镜像）──
  const extended = new ExtendedMemoryStore(config.memoryDir)
  await extended.load()

  // ── 常驻指令 ──
  const standing = config.standingInstructionsEnabled !== false
    ? new StandingInstructions(path.join(memoryDir, STANDING_FILE))
    : null
  await standing?.load()

  // ── 运行时（项目存储惰性装配，需先占位 runtime 引用）──
  let runtime!: ReturnType<typeof buildRuntime>
  const attachProjectStore = (store: MemoryStore, projectName: string): void => {
    store.setMutationObserver(makeMutationObserver(extended, projectName))
    makeAutoConsolidator(runtime, 'project')(store, projectName)
  }
  runtime = buildRuntime(ctx, config, memoryDir, projectsRoot, extended, standing, attachProjectStore)

  // ── 全局存储装配：镜像观察者 + 自动整合器 ──
  runtime.store.setMutationObserver(makeMutationObserver(extended))
  makeAutoConsolidator(runtime, 'memory')(runtime.store, '')

  // ── 初始加载 + 镜像回填（尽力而为，不阻塞启动）──
  await runtime.store.loadFromDisk()
  try {
    await extended.reconcileAllMarkdown(memoryDir, config.projectsMemoryDir)
  } catch (error) {
    console.warn(`[dsh-hermes-memory] Search mirror backfill failed: ${String(error)}`)
  }

  // ── 系统提示段 ──
  registerPromptSections(ctx, runtime)

  // ── 工具 ──
  registerMemoryTools(ctx, runtime)
  registerMemorySearchTool(ctx, runtime)
  registerSessionSearchTool(ctx, () => {
    const sessionQuery = ctx.get('sessionQuery') as {
      searchSessions(request: { query: string; limit?: number }, exec?: { signal?: AbortSignal }): Promise<{ items: readonly import('@deepseek-ai/dsh-session-query').SessionSearchHit[] }>
    } | undefined
    return sessionQuery
  })
  registerSkillTool(ctx, runtime)
  registerSkillProvider(ctx, runtime)

  // ── 处理器 ──
  setupBackgroundReview(ctx, runtime)
  setupCorrectionDetector(ctx, runtime)
  setupSessionFlush(ctx, runtime)

  // ── 命令 ──
  registerCommands(ctx, runtime)

  // ── 会话开始：刷新磁盘状态 + 预热项目存储 ──
  ctx.on('agent/session-start', async (payload) => {
    const cwd = payload.agent.session.header.cwd
    const project = runtime.projectStores.resolve(cwd)
    try {
      await runtime.store.loadFromDisk()
      if (project.store) await project.store.loadFromDisk()
    } catch {
      // 尽力而为 — 不阻塞会话启动
    }
  })
}
