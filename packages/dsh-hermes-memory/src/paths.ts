/**
 * 路径解析 — dsh 版存储布局。
 *
 * 上游（pi-hermes-memory）以 `~/.pi/agent/` 为根；本移植以 dsh 的
 * `$DSH_HOME`（默认 `~/.dsh`，与 @deepseek-ai/dsh-home-paths 的解析规则一致）为根：
 * - 全局记忆：`$DSH_HOME/hermes-memory/`（MEMORY.md / USER.md / failures.md / STANDING.md / extended-memory.json / skills/）
 * - 项目记忆：`$DSH_HOME/projects-memory/<project>/`（MEMORY.md / skills/）
 */

import * as os from 'node:os'
import * as path from 'node:path'
import { DEFAULT_PROJECTS_MEMORY_DIR } from './constants.ts'

/** $DSH_HOME 环境变量名（与 dsh-home-paths 一致）。 */
export const DSH_HOME_ENV = 'DSH_HOME'

/**
 * 解析 dsh 数据根目录。
 * 优先级：显式配置 > $DSH_HOME > ~/.dsh；空值按未设置处理。
 * @param env - 环境变量映射
 * @returns 归一化的绝对路径
 */
export function dshHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env[DSH_HOME_ENV]?.trim()
  if (configured) return path.resolve(expandHome(configured))
  return path.join(os.homedir(), '.dsh')
}

/**
 * 展开受支持的波浪号前缀。
 * @param input - 配置路径，可能以 `~` 或 `~/` 开头
 * @returns 展开后的路径；无受支持前缀时返回原值
 */
export function expandHome(input: string): string {
  if (input === '~') return os.homedir()
  if (input.startsWith('~/') || input.startsWith('~\\')) {
    return path.join(os.homedir(), input.slice(2))
  }
  return input
}

/**
 * 归一化配置的记忆目录：绝对路径原样使用，相对路径按 $DSH_HOME 解析。
 * @param input - 配置的 memoryDir
 * @returns 归一化绝对路径；输入无效时返回 undefined
 */
export function normalizeConfiguredMemoryDir(input: string): string | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined

  const expanded = expandHome(trimmed)
  if (path.isAbsolute(expanded)) return path.normalize(expanded)
  return path.resolve(dshHome(), expanded)
}

/** projectsMemoryDir 必须是 $DSH_HOME 下的单段安全相对目录。 */
function isSafeRelativeDirectory(input: string): boolean {
  const segments = input.split(/[\\/]+/).filter(Boolean)
  return segments.length === 1 && segments[0] !== '.' && segments[0] !== '..'
}

/**
 * 归一化项目记忆目录配置（$DSH_HOME 下的相对目录名）。
 * @param input - 配置的 projectsMemoryDir
 * @returns 归一化相对目录名；不安全时返回 undefined
 */
export function normalizeProjectsMemoryDir(input: string): string | undefined {
  const trimmed = input.trim()
  if (!trimmed) return undefined

  const expanded = expandHome(trimmed)
  let relative = expanded

  if (path.isAbsolute(expanded)) {
    const resolved = path.resolve(expanded)
    const relativeToHome = path.relative(dshHome(), resolved)
    if (
      relativeToHome === ''
      || relativeToHome.startsWith('..')
      || path.isAbsolute(relativeToHome)
    ) {
      return undefined
    }
    relative = relativeToHome
  }

  const normalized = path.normalize(relative).replace(/^[\\/]+|[\\/]+$/g, '')
  if (!isSafeRelativeDirectory(normalized)) return undefined
  return normalized
}

/**
 * 项目记忆根目录。
 * @param projectsMemoryDir - 配置的 projectsMemoryDir
 * @returns 绝对路径
 */
export function resolveProjectsRoot(projectsMemoryDir = DEFAULT_PROJECTS_MEMORY_DIR): string {
  const normalized = normalizeProjectsMemoryDir(projectsMemoryDir) ?? DEFAULT_PROJECTS_MEMORY_DIR
  return path.join(dshHome(), normalized)
}

/**
 * 全局记忆存储根目录。
 * @param memoryDir - 配置的 memoryDir（未配置时用默认目录）
 * @returns 绝对路径
 */
export function resolveMemoryRoot(memoryDir?: string): string {
  if (memoryDir) {
    const normalized = normalizeConfiguredMemoryDir(memoryDir)
    if (normalized) return normalized
  }
  return path.join(dshHome(), 'hermes-memory')
}
