/**
 * 技能工具函数 — frontmatter 解析/格式化、slug、相似度。
 * 移植自 pi-hermes-memory/src/store/skill-utils.ts（MIT）。
 */

import * as fs from 'node:fs/promises'
import type { SkillDocument, SkillScope } from '../types.ts'

export interface ParsedSkillFile {
  meta: Record<string, string>
  body: string
}

function parseScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      const parsed = JSON.parse(trimmed)
      if (typeof parsed === 'string') return parsed
    } catch {
      // 回退到原始 trimmed
    }
  }
  return trimmed
}

/**
 * 解析 SKILL.md frontmatter。
 * @param raw - 文件原文
 */
export function parseFrontmatter(raw: string): ParsedSkillFile {
  const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: raw.trim() }

  const meta: Record<string, string> = {}
  for (const line of match[1]!.split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) {
      const key = line.slice(0, idx).trim()
      const value = parseScalar(line.slice(idx + 1))
      meta[key] = value
    }
  }

  return { meta, body: match[2]!.trim() }
}

function yamlDoubleQuoted(value: string): string {
  return JSON.stringify(value)
}

/**
 * 格式化 SKILL.md（frontmatter + 正文）。
 * @param doc - 技能文档字段
 */
export function formatFrontmatter(doc: Pick<SkillDocument, 'name' | 'displayName' | 'description' | 'version' | 'created' | 'updated' | 'body'>): string {
  const lines = [
    '---',
    `name: ${yamlDoubleQuoted(doc.name)}`,
    `description: ${yamlDoubleQuoted(doc.description)}`,
    `version: ${doc.version}`,
    `created: ${yamlDoubleQuoted(doc.created)}`,
    `updated: ${yamlDoubleQuoted(doc.updated)}`,
  ]

  if (doc.displayName && doc.displayName.trim() && doc.displayName.trim() !== doc.name) {
    lines.push(`display_name: ${yamlDoubleQuoted(doc.displayName.trim())}`)
  }

  lines.push('---', doc.body)
  return lines.join('\n')
}

/**
 * 名字转 slug（kebab-case，最多 64 字符）。
 * @param name - 技能名
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .replace(/--+/g, '-')
    .slice(0, 64)
}

/** 今天的 ISO 日期。 */
export function today(): string {
  return new Date().toISOString().slice(0, 10)
}

const SKILL_SIMILARITY_STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'in', 'into', 'is', 'it',
  'of', 'on', 'or', 'that', 'the', 'this', 'to', 'use', 'using', 'with', 'workflow', 'procedure', 'step',
  'steps', 'guide', 'skill', 'skills', 'repo', 'project',
])

/**
 * 相似度分词（去掉停用词）。
 * @param input - 原文
 */
export function tokenizeForSimilarity(input: string): string[] {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 1 && !SKILL_SIMILARITY_STOP_WORDS.has(token))
}

/**
 * Jaccard 相似度。
 * @param a - 词集 A
 * @param b - 词集 B
 */
export function jaccardSimilarity(a: string[], b: string[]): number {
  const aSet = new Set(a)
  const bSet = new Set(b)
  if (aSet.size === 0 || bSet.size === 0) return 0

  let intersection = 0
  for (const token of aSet) {
    if (bSet.has(token)) intersection++
  }

  const union = new Set([...aSet, ...bSet]).size
  return union === 0 ? 0 : intersection / union
}

/**
 * 构建技能 id。
 * @param scope - 作用域
 * @param slug - slug
 * @param projectName - 项目名（project 作用域）
 */
export function buildSkillId(scope: SkillScope, slug: string, projectName?: string | null): string {
  return scope === 'project' ? `project:${projectName ?? ''}:${slug}` : `global:${slug}`
}

/**
 * 解析技能 id。
 * @param skillId - 技能 id
 * @returns 解析结果；格式非法时返回 null
 */
export function parseSkillId(skillId: string): { scope: SkillScope; projectName?: string; slug: string } | null {
  if (skillId.startsWith('global:')) {
    return { scope: 'global', slug: skillId.slice('global:'.length) }
  }

  if (skillId.startsWith('project:')) {
    const rest = skillId.slice('project:'.length)
    const idx = rest.indexOf(':')
    if (idx <= 0 || idx === rest.length - 1) return null
    return {
      scope: 'project',
      projectName: rest.slice(0, idx),
      slug: rest.slice(idx + 1),
    }
  }

  return null
}

/**
 * 判断文件是否存在。
 * @param filePath - 路径
 */
export async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}
