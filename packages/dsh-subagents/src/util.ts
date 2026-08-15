/**
 * 通用小工具：格式化、路径、原子 JSON 读写、深合并。
 */

import { createHash } from 'node:crypto'
import { statSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import * as path from 'node:path'

/** 人类可读时长：`1m 12s`。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '-'
  const totalSeconds = Math.max(0, Math.round(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/** 人类可读字节数。 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/** 截断文本到最大长度，保留前缀。 */
export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength)}…`
}

/** 把 `~` / `~/...` 前缀展开为用户主目录。 */
export function expandTilde(p: string): string {
  return p.startsWith('~/') ? path.join(homedir(), p.slice(2)) : p
}

function homedir(): string {
  return process.env.HOME ?? process.env.USERPROFILE ?? '/tmp'
}

/** 展开 `~` 并解析为绝对路径。 */
export function resolvePath(p: string, base?: string): string {
  const expanded = expandTilde(p)
  return path.isAbsolute(expanded) ? expanded : path.resolve(base ?? process.cwd(), expanded)
}

/** 项目根的稳定哈希（用于用户级 mission 目录隔离）。 */
export function projectHash(cwd: string): string {
  return createHash('sha256').update(resolvePath(cwd)).digest('hex').slice(0, 16)
}

/** 从项目根向上查找第一个包含 `.dsh` 或 `.git` 的目录。 */
export function resolveProjectRoot(cwd: string): string {
  const home = homedir()
  let current = resolvePath(cwd)
  for (;;) {
    if (hasEntry(current, '.dsh') || hasEntry(current, '.git')) {
      // home 自身的 .dsh/.git 不是项目标记：命中 home 视为无项目根，
      // 返回 cwd，避免 project 作用域与 user 作用域（~/.dsh）物理重合。
      if (current === home) return resolvePath(cwd)
      return current
    }
    const parent = path.dirname(current)
    if (parent === current) return resolvePath(cwd)
    current = parent
  }
}

function hasEntry(dir: string, name: string): boolean {
  try {
    return statSync(path.join(dir, name)).isDirectory()
  } catch {
    return false
  }
}

/** 原子写 JSON：先写临时文件再 rename。 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await rename(tmp, filePath)
}

/** 原子写文本。 */
export async function writeTextAtomic(filePath: string, text: string): Promise<void> {
  const dir = path.dirname(filePath)
  await mkdir(dir, { recursive: true })
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, text, 'utf8')
  await rename(tmp, filePath)
}

/** 读 JSON 文件，缺失或损坏返回 undefined（可传 onError 观察损坏）。 */
export async function readJsonFile<T>(filePath: string, onError?: (error: unknown) => void): Promise<T | undefined> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    return undefined
  }
  try {
    return JSON.parse(raw) as T
  } catch (error) {
    onError?.(error)
    return undefined
  }
}

/** 读文本文件，缺失返回 undefined。 */
export async function readTextFile(filePath: string): Promise<string | undefined> {
  try {
    return await readFile(filePath, 'utf8')
  } catch {
    return undefined
  }
}

/** 判断是否为普通对象（非数组、非 null）。 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 深度合并（只合并普通对象，数组与标量直接替换）。 */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(patch)) return patch as T
  const out: Record<string, unknown> = { ...(isPlainObject(base) ? base : {}) }
  for (const [key, value] of Object.entries(patch)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key], value)
    } else {
      out[key] = value
    }
  }
  return out as T
}

/** 转义正则特殊字符。 */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把任意值规范为字符串（管理 config 用）。 */
export function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value === false || value === '' || value === undefined || value === null) return undefined
  return String(value)
}
