/**
 * 斜杠命令 — /memory-* 系列。
 * 移植自 pi-hermes-memory/src/handlers/（insights/switch-project/standing-pin/
 * preview-context/interview/index-sessions/sync-markdown-memories/learn-memory/
 * skills-command）。上游用 TUI notify/select 展示；dsh 命令返回
 * CommandResult 文本直接渲染。
 */

import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { CommandResult } from '@deepseek-ai/dsh-commands'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import {
  INTERVIEW_PROMPT,
  MEMORY_FILE,
  STANDING_MAX_CHARS,
  STANDING_MAX_ENTRIES,
} from '../constants.ts'
import type { HermesRuntime } from '../runtime.ts'
import { runManualConsolidation } from './consolidate.ts'
import { resolveMemoryPolicyPrompt } from '../prompt-context.ts'
import { cwdFromInvocation } from './command-util.ts'

const ok = (text: string): CommandResult => ({ kind: 'success', text })
const err = (text: string): CommandResult => ({ kind: 'error', text })

/** 面板框线工具。 */
function box(title: string): string[] {
  return [
    '',
    `  ╔══════════════════════════════════════════════╗`,
    `  ║            ${title.padEnd(38, ' ')}║`,
    `  ╚══════════════════════════════════════════════╝`,
    '',
  ]
}

/** 预览用：追加常驻指令块。 */
function appendStandingBlock(lines: string[], runtime: HermesRuntime): number {
  const rendered = runtime.standing?.render()
  if (!rendered?.block) return 0
  lines.push('  ── STANDING INSTRUCTIONS (always injected) ─────────────────')
  lines.push(rendered.block)
  if (rendered.omittedCount > 0) {
    lines.push(`  ⚠️ ${rendered.omittedCount} pinned instruction(s) exceed the budget and are NOT injected.`)
  }
  lines.push('')
  return 1
}

/**
 * 注册全部 /memory-* 命令。
 * @param ctx - 插件上下文
 * @param runtime - 插件运行时
 */
export function registerCommands(ctx: Context, runtime: HermesRuntime): void {
  const { store, projectStores, extended, skillStore, standing, config } = runtime
  const commands = ctx.get('commands') as { register(definition: { name: string; description: string; handler: (invocation: { agent: { session?: { header?: { cwd?: string } } }; rawInput: string; signal: AbortSignal }) => CommandResult | Promise<CommandResult> }): unknown } | undefined
  if (commands === undefined) return

  const register = (name: string, description: string, handler: (cwd: string | undefined, rawInput: string, signal: AbortSignal) => Promise<CommandResult> | CommandResult): void => {
    commands.register({
      name,
      description,
      handler: (invocation) => handler(cwdFromInvocation(invocation.agent), invocation.rawInput, invocation.signal),
    })
  }

  // ── /memory-insights ──
  register('memory-insights', 'Show what\'s stored in persistent memory', async (cwd) => {
    const memoryEntries = store.getMemoryEntries()
    const userEntries = store.getUserEntries()
    const project = projectStores.resolve(cwd)
    const projectEntries = project.store ? project.store.getMemoryEntries() : null

    const lines = [...box('🧠 Memory Insights')]

    lines.push('  📋 MEMORY (your personal notes)')
    lines.push('  ' + '─'.repeat(44))
    if (memoryEntries.length === 0) lines.push('  (empty)')
    else memoryEntries.forEach((entry, i) => lines.push(`  ${i + 1}. ${entry.length > 100 ? entry.slice(0, 100) + '...' : entry}`))
    lines.push('')

    lines.push('  👤 USER PROFILE')
    lines.push('  ' + '─'.repeat(44))
    if (userEntries.length === 0) lines.push('  (empty)')
    else userEntries.forEach((entry, i) => lines.push(`  ${i + 1}. ${entry.length > 100 ? entry.slice(0, 100) + '...' : entry}`))
    lines.push('')

    if (projectEntries !== null) {
      lines.push(`  📁 PROJECT MEMORY: ${project.name ?? ''}`)
      lines.push('  ' + '─'.repeat(44))
      if (projectEntries.length === 0) lines.push('  (empty)')
      else projectEntries.forEach((entry, i) => lines.push(`  ${i + 1}. ${entry.length > 100 ? entry.slice(0, 100) + '...' : entry}`))
      lines.push('')
    }

    return ok(lines.join('\n'))
  })

  // ── /memory-skills ──
  register('memory-skills', 'List all saved procedural skills', async () => {
    const index = await skillStore.loadIndex()
    const lines = [...box('📚 Skills')]
    if (index.length === 0) {
      lines.push('  (no skills saved yet)')
      lines.push('')
      lines.push('  Skills are created by the agent through the skill_manage tool')
      lines.push('  when a reusable procedure is worth saving.')
    } else {
      for (const skill of index) {
        const badge = skill.scope === 'global' ? '[G]' : '[P]'
        lines.push(`  ${badge} ${skill.name}${skill.displayName && skill.displayName !== skill.name ? ` (${skill.displayName})` : ''}`)
        lines.push(`      ${skill.description}`)
        lines.push(`      ${skill.skillId} · updated ${skill.updated}`)
        lines.push('')
      }
    }
    return ok(lines.join('\n'))
  })

  // ── /memory-consolidate ──
  register('memory-consolidate', 'Manually trigger memory consolidation to free up space', async (cwd) => {
    return runManualConsolidation(cwd, runtime)
  })

  // ── /memory-interview ──
  // 上游用 pi.sendUserMessage 把访谈提示词发给 agent；dsh 用 agent.steer
  // 注入一条插件来源的用户消息，空闲 driver 会开启新一轮。
  commands.register({
    name: 'memory-interview',
    description: 'Answer a few questions to pre-fill your user profile so the agent remembers you across sessions',
    handler: (invocation) => {
      const userEntries = store.getUserEntries()
      const lines: string[] = []
      if (userEntries.length > 0) {
        lines.push(
          `\n  🧠 You already have ${userEntries.length} profile entr${userEntries.length === 1 ? 'y' : 'ies'}:\n`
          + userEntries.map((e) => `     • ${e.slice(0, 80)}${e.length > 80 ? '...' : ''}`).join('\n')
          + '\n\n  Starting the interview will add to or update these.\n',
        )
      }
      const agent = invocation.agent as { steer?: (message: unknown) => void }
      if (typeof agent.steer === 'function') {
        const message = createUserMessage({
          content: [{ type: 'text', text: INTERVIEW_PROMPT }],
          source: { kind: 'plugin', plugin: 'dsh-hermes-memory', form: 'instructions' },
        })
        agent.steer(message)
        lines.push('  💬 访谈已开始 — 请回答 agent 的问题。')
      } else {
        lines.push('  ❌ 无法启动访谈：当前 agent 不支持注入消息。')
      }
      return ok(lines.join('\n'))
    },
  })

  // ── /memory-switch-project ──
  register('memory-switch-project', 'List all project memories and their entry counts', async (cwd) => {
    const projectsRoot = runtime.projectsRoot
    let projects: Array<{ name: string; count: number }> = []
    try {
      const entries = await fs.readdir(projectsRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        try {
          const raw = await fs.readFile(path.join(projectsRoot, entry.name, MEMORY_FILE), 'utf-8')
          const count = raw.split('\n§\n').filter(Boolean).length
          projects.push({ name: entry.name, count })
        } catch { /* 无 MEMORY.md — 跳过 */ }
      }
    } catch {
      // 目录不存在 — 无项目
    }

    if (projects.length === 0) {
      return ok('\n  📁 No project memories found.\n\n  Project memory is automatically created when you use memory_add with\n  target \'project\' while working in a project directory.\n')
    }

    const lines = [...box('📁 Project Memory — Switch')]
    lines.push('  Available project memories:')
    lines.push('')
    for (const proj of projects.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`  📁 ${proj.name} (${proj.count} ${proj.count === 1 ? 'entry' : 'entries'})`)
    }
    lines.push('')
    lines.push('  Use memory_add with target \'project\' to manage project-scoped')
    lines.push(`  memory. Project is auto-detected from the current directory: ${cwd ?? '(unknown)'}`)
    return ok(lines.join('\n'))
  })

  // ── /memory-index-sessions ──
  register('memory-index-sessions', 'Show the dsh session index status', async () => {
    const sessionQuery = ctx.get('sessionQuery') as { listSessions?: (signal?: AbortSignal) => Promise<unknown[]> } | undefined
    const lines = [...box('🔍 Session Index')]
    lines.push('  dsh 自动维护会话全文索引（sessionQuery / SQLite FTS）。')
    lines.push('  无需手动导入；session_search 直接查询该索引。')
    lines.push('')
    if (sessionQuery?.listSessions) {
      try {
        const sessions = await sessionQuery.listSessions()
        lines.push(`  Indexed sessions: ${sessions.length}`)
      } catch {
        lines.push('  Indexed sessions: (unavailable)')
      }
    } else {
      lines.push('  Indexed sessions: (sessionQuery service not mounted)')
    }
    lines.push('')
    lines.push('  💡 Use the session_search tool to search across sessions.')
    return ok(lines.join('\n'))
  })

  // ── /memory-sync-markdown ──
  register('memory-sync-markdown', 'Reconcile the search mirror with Markdown memories', async () => {
    const counters = await extended.reconcileAllMarkdown(store.getMemoryDir(), config.projectsMemoryDir)
    const lines = [...box('🔄 Markdown → Search Mirror Sync')]
    lines.push(`  Files scanned: ${counters.inserted + counters.existing + counters.removed}`)
    lines.push(`  Imported into mirror: ${counters.inserted}`)
    lines.push(`  Skipped as duplicates: ${counters.existing}`)
    lines.push(`  Removed orphaned rows: ${counters.removed}`)
    lines.push('')
    lines.push('  💡 Re-running this command is safe — rows are de-duplicated.')
    return ok(lines.join('\n'))
  })

  // ── /memory-preview-context ──
  register('memory-preview-context', 'Preview the memory policy or legacy memory context blocks', async (cwd) => {
    const lines = [...box('Injected Context Preview')]
    if (config.memoryMode === 'policy-only') {
      lines.push('  Mode: policy-only')
      lines.push(`  Policy style: ${config.memoryPolicyStyle ?? 'full'}`)
      lines.push('  This is the memory policy appended to the system prompt.')
      lines.push('  Full Markdown memories are NOT injected in this mode.')
      lines.push('')
      let blockCount = 0
      const policyPrompt = resolveMemoryPolicyPrompt(config)
      if (policyPrompt) {
        blockCount++
        lines.push(policyPrompt)
        lines.push('')
      } else {
        lines.push('  No memory policy context is injected for this policy style.')
        lines.push('')
      }
      blockCount += appendStandingBlock(lines, runtime)
      lines.push(`  Blocks shown: ${blockCount}`)
      return ok(lines.join('\n'))
    }

    const project = projectStores.resolve(cwd)
    const memoryBlock = store.formatForSystemPrompt()
    const projectBlock = project.store ? project.store.formatProjectBlock(project.name ?? '') : ''
    let blockCount = 0
    if (memoryBlock) {
      blockCount++
      lines.push('  ── MEMORY + USER + RECENT FAILURES ─────────────────────────')
      lines.push(memoryBlock)
      lines.push('')
    }
    if (projectBlock) {
      blockCount++
      lines.push(`  ── PROJECT MEMORY (${project.name ?? ''}) ─────────────────────────`)
      lines.push(projectBlock)
      lines.push('')
    }
    blockCount += appendStandingBlock(lines, runtime)
    if (blockCount === 0) {
      lines.push('  No memory context blocks are currently injected.')
      lines.push('  Add memory entries, then run this command again.')
      lines.push('')
    }
    lines.push(`  Blocks shown: ${blockCount}`)
    return ok(lines.join('\n'))
  })

  // ── /memory-pin ──
  register('memory-pin', 'Pin a standing instruction that is injected into every session', async (_cwd, rawInput) => {
    if (!standing) return err('Standing instructions are disabled (standingInstructionsEnabled: false).')
    if (!standing.isLoaded()) await standing.load()

    const input = rawInput.trim()
    const [head, ...rest] = input.split(/\s+/)
    const subcommand = head?.toLowerCase()

    const formatList = (): string[] => {
      const instructions = standing.list()
      const lines = [...box('📌 Standing Instructions')]
      if (instructions.length === 0) {
        lines.push('  (none pinned)')
        lines.push('')
        lines.push('  Pin a rule that must hold in every session:')
        lines.push('    /memory-pin never run find / or other root-wide searches')
        lines.push('')
        return lines
      }
      const { injectedCount, omittedCount } = standing.render()
      const used = instructions.join('\n').length
      for (const [index, instruction] of instructions.entries()) {
        lines.push(`  ${index + 1}. ${instruction}`)
      }
      lines.push('')
      lines.push(`  ${instructions.length}/${STANDING_MAX_ENTRIES} entries · ${used}/${STANDING_MAX_CHARS} chars`)
      lines.push(`  Injected into every session: ${injectedCount}`)
      if (omittedCount > 0) {
        lines.push(`  ⚠️ ${omittedCount} over budget and NOT injected — remove or shorten entries.`)
      }
      lines.push(`  File: ${standing.getFilePath()}`)
      lines.push('')
      lines.push('  /memory-pin remove <n> · /memory-pin clear')
      lines.push('')
      return lines
    }

    if (input === '' || subcommand === 'list') {
      return ok(formatList().join('\n'))
    }

    if (subcommand === 'clear') {
      const result = await standing.clear()
      return result.success ? ok(`📌 ${result.message}`) : err(`❌ ${result.error}`)
    }

    if (subcommand === 'remove') {
      const position = Number(rest[0])
      const result = await standing.remove(position)
      if (!result.success) return err(`❌ ${result.error}`)
      return ok([`📌 ${result.message}`, '', ...formatList()].join('\n'))
    }

    const result = await standing.add(input)
    if (!result.success) return err(`❌ ${result.error}`)
    return ok(
      [
        `📌 ${result.message}`,
        '',
        '  This is now injected into every session, in all memory modes.',
        '  It takes effect from your next message.',
        '',
      ].join('\n'),
    )
  })

  // ── /learn-memory-tool ──
  register('learn-memory-tool', 'Learn how to use the memory system effectively', async () => {
    const lines = [...box('🧠 Memory Guide')]
    lines.push('  Type            │ File          │ Limit')
    lines.push('  ────────────────┼───────────────┼────────────')
    lines.push('  🧠 Memory       │ MEMORY.md     │ 5,000 chars')
    lines.push('  👤 User Profile │ USER.md       │ 5,000 chars')
    lines.push('  ⚠️  Failures     │ failures.md   │ 10,000 chars')
    lines.push('  📚 Skills       │ SKILL.md dirs │ Unlimited')
    lines.push('  💾 Extended     │ extended-memory.json │ Unlimited')
    lines.push('')
    lines.push('  Tools:')
    lines.push('    memory_add / memory_replace / memory_remove')
    lines.push('    memory_search — search the extended store (filters: project, target, category)')
    lines.push('    session_search — search past conversations')
    lines.push('    skill_manage — create/view/patch/update/delete procedural skills')
    lines.push('')
    lines.push('  Commands:')
    lines.push('    /memory-insights · /memory-skills · /memory-consolidate')
    lines.push('    /memory-interview · /memory-switch-project')
    lines.push('    /memory-index-sessions · /memory-sync-markdown')
    lines.push('    /memory-preview-context · /memory-pin · /learn-memory-tool')
    lines.push('')
    lines.push('  ✅ DO save: preferences, corrections, environment facts, conventions, failures')
    lines.push('  ❌ DON\'T save: task progress, session outcomes, temporary state')
    lines.push('')
    lines.push('  1. Session starts → compact memory policy is injected')
    lines.push('  2. Agent searches memory when useful (memory_search)')
    lines.push('  3. Agent saves → Markdown memory + search mirror sync')
    lines.push('  4. Every N turns → background review saves items')
    lines.push('  5. On correction → immediate save as [correction] category')
    lines.push('  6. On failure → saves what failed + why')
    lines.push('  7. When full → auto-consolidation merges')
    lines.push('  8. Session ends → final flush')
    lines.push('')
    lines.push('  Legacy mode: set memoryMode="legacy-inject" to restore full')
    lines.push('  MEMORY.md, USER.md, project memory, and failure prompt blocks.')
    return ok(lines.join('\n'))
  })
}
