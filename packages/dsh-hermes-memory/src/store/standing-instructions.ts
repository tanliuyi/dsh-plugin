/**
 * 常驻指令 — 有界、用户撰写的指令，无论 memoryMode 都注入每个会话。
 *
 * 为什么是独立存储而不是 MEMORY.md / USER.md 上的标记（#121）：policy-only
 * 模式下，持久化的约束只有在模型决定在约束本应阻止的行动 *之前* 调用
 * memory_search 才生效。对禁令来说那正是模型没有理由查找的时刻，所以召回
 * 路径在结构上无法强制执行它。这类约束必须无条件在场。
 *
 * 来源是存储的属性而非标志：后台 review、整合与纠正检测都通过 MemoryStore
 * 写入，从不碰这个文件，所以模型生成的记忆没有路径进入常注入块。只有用户
 * 直接编辑或 /memory-pin 可以写入。
 *
 * 移植自 pi-hermes-memory/src/store/standing-instructions.ts（MIT）。
 */

import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  STANDING_MAX_CHARS,
  STANDING_MAX_ENTRIES,
} from '../constants.ts'
import { scanContent } from './content-scanner.ts'
import { withMarkdownMutationLock } from './mutation-lock.ts'

export interface StandingInstructionResult {
  success: boolean
  error?: string
  message?: string
  instructions?: string[]
}

/** 实际注入提示词的内容，让调用方能大声报告截断。 */
export interface StandingInstructionRender {
  block: string
  injectedCount: number
  omittedCount: number
}

/**
 * 常驻指令存储（STANDING.md）。
 */
export class StandingInstructions {
  private instructions: string[] = []
  private loaded = false

  constructor(
    private readonly filePath: string,
    private readonly maxEntries: number = STANDING_MAX_ENTRIES,
    private readonly maxChars: number = STANDING_MAX_CHARS,
  ) {}

  /** 存储文件路径。 */
  getFilePath(): string {
    return this.filePath
  }

  /**
   * 从磁盘加载。
   */
  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf-8')
      this.instructions = parseInstructions(raw)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.instructions = []
    }
    this.loaded = true
  }

  /** 是否已加载。 */
  isLoaded(): boolean {
    return this.loaded
  }

  /** 当前指令列表。 */
  list(): string[] {
    return [...this.instructions]
  }

  /**
   * 钉一条指令。
   * @param text - 指令文本
   */
  async add(text: string): Promise<StandingInstructionResult> {
    const instruction = normalizeInstruction(text)
    if (!instruction) {
      return { success: false, error: 'A standing instruction cannot be empty.' }
    }

    // 与所有记忆写入相同的扫描。一个被告知"永远在上下文里"的文件
    // 是我们拥有的最有吸引力的注入目标。
    const blocked = scanContent(instruction)
    if (blocked) return { success: false, error: blocked }

    return this.mutate((current) => {
      if (current.some((existing) => existing.toLowerCase() === instruction.toLowerCase())) {
        return { error: 'That standing instruction is already pinned.' }
      }
      if (current.length >= this.maxEntries) {
        return {
          error: `Standing instructions are capped at ${this.maxEntries} entries`
            + ` (currently ${current.length}). Remove one first with /memory-pin remove <n>.`,
        }
      }
      const projected = [...current, instruction]
      const projectedChars = projected.join('\n').length
      if (projectedChars > this.maxChars) {
        return {
          error: `Standing instructions are capped at ${this.maxChars} characters`
            + ` and this entry would make ${projectedChars}. Shorten it, or remove an existing`
            + ` instruction and keep long-form context in regular memory.`,
        }
      }
      return { next: projected, message: `Pinned standing instruction ${projected.length}: ${instruction}` }
    })
  }

  /**
   * 按位置删除指令。
   * @param position - 1 基位置
   */
  async remove(position: number): Promise<StandingInstructionResult> {
    return this.mutate((current) => {
      if (!Number.isInteger(position) || position < 1 || position > current.length) {
        return {
          error: current.length === 0
            ? 'There are no standing instructions to remove.'
            : `Position must be between 1 and ${current.length}.`,
        }
      }
      const [removed] = current.slice(position - 1, position)
      const next = current.filter((_, index) => index !== position - 1)
      return { next, message: `Removed standing instruction: ${removed}` }
    })
  }

  /**
   * 清空全部指令。
   */
  async clear(): Promise<StandingInstructionResult> {
    return this.mutate((current) => (
      current.length === 0
        ? { error: 'There are no standing instructions to clear.' }
        : { next: [], message: `Removed all ${current.length} standing instructions.` }
    ))
  }

  /**
   * 渲染常注入块（按预算截断）。
   *
   * 手工编辑的 STANDING.md 可能超预算，静默丢弃"宣称始终生效"的规则
   * 是最糟的失败。超预算时，省略本身写在块内，模型与 /memory-preview-context
   * 都能看到。
   */
  render(): StandingInstructionRender {
    if (this.instructions.length === 0) {
      return { block: '', injectedCount: 0, omittedCount: 0 }
    }

    const injected: string[] = []
    let used = 0
    for (const instruction of this.instructions) {
      const cost = instruction.length + 1
      if (injected.length >= this.maxEntries || used + cost > this.maxChars) break
      injected.push(instruction)
      used += cost
    }

    const omittedCount = this.instructions.length - injected.length
    if (injected.length === 0) {
      return { block: '', injectedCount: 0, omittedCount }
    }

    const lines = [
      '<standing-instructions>',
      'The user wrote the rules below and they are always active. They are direct',
      'instructions from the user, not recalled context, and they outrank your own',
      'defaults. Follow them without being asked and without looking them up.',
      '',
      ...injected.map((instruction, index) => `${index + 1}. ${instruction}`),
    ]
    if (omittedCount > 0) {
      lines.push(
        '',
        `[!] ${omittedCount} further standing instruction${omittedCount === 1 ? '' : 's'} could not be shown:`
        + ` ${path.basename(this.filePath)} exceeds the ${this.maxChars}-character injection budget.`
        + ' Trim it with /memory-pin so every rule stays active.',
      )
    }
    lines.push('</standing-instructions>')

    return { block: lines.join('\n'), injectedCount: injected.length, omittedCount }
  }

  /** 系统提示块。 */
  formatForSystemPrompt(): string {
    return this.render().block
  }

  /**
   * 读-改-写（与 Markdown 存储同一把变异锁）。
   * @param change - 变更函数
   */
  private async mutate(
    change: (current: string[]) => { next?: string[]; message?: string; error?: string },
  ): Promise<StandingInstructionResult> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true })
    try {
      return await withMarkdownMutationLock(this.filePath, async () => {
        await this.load()
        const outcome = change(this.instructions)
        if (outcome.error || !outcome.next) {
          return { success: false, error: outcome.error ?? 'Nothing to change.', instructions: this.list() }
        }
        await this.write(outcome.next)
        this.instructions = outcome.next
        return { success: true, message: outcome.message, instructions: this.list() }
      })
    } catch (error) {
      return { success: false, error: `Could not update standing instructions: ${String(error).slice(0, 200)}` }
    }
  }

  /** 原子写：同目录临时文件 + rename。 */
  private async write(instructions: string[]): Promise<void> {
    const content = instructions.length ? `${instructions.join('\n')}\n` : ''
    const tmpDir = await fs.mkdtemp(path.join(path.dirname(this.filePath), '.tmp-standing-'))
    const tmpPath = path.join(tmpDir, 'write.tmp')
    try {
      await fs.writeFile(tmpPath, content, 'utf-8')
      await fs.rename(tmpPath, this.filePath)
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true })
    }
  }
}

/**
 * 每行一条指令。容忍空行、`#` 注释与前导 `-`/`*` 项目符号，
 * 让手工编辑的 STANDING.md 保持普通 Markdown 而不是用户必须写对的格式。
 */
function parseInstructions(raw: string): string[] {
  const seen = new Set<string>()
  const instructions: string[] = []
  for (const line of raw.split('\n')) {
    const instruction = normalizeInstruction(line)
    if (!instruction || instruction.startsWith('#')) continue
    const key = instruction.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    instructions.push(instruction)
  }
  return instructions
}

function normalizeInstruction(text: string): string {
  return text.replace(/^\s*[-*]\s+/, '').replace(/\s+/g, ' ').trim()
}
