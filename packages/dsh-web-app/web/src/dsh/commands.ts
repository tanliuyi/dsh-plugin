/** Slash-command discovery and submit adjudication aligned with upstream ui-commands. */

import type { CommandEntry, SkillEntry } from './api'

export interface ParsedCommand {
  name: string
  rawInput: string
}

export type CommandDisposition =
  | { kind: 'execute'; line: string; command: CommandEntry }
  | { kind: 'prompt' }
  /** 命令目录故障，但该名字在保留缓存中可证明是 host command：报错并保留输入，绝不落 prompt。 */
  | { kind: 'unavailable'; name: string }

/** Parse one exact host command candidate without normalizing its trailing input. */
export function parseCommand(line: string): ParsedCommand | undefined {
  const match = /^\/([a-z][a-z0-9_-]*)(?=$|[\t\n\r ])/u.exec(line)
  const name = match?.[1]
  if (match === null || name === undefined) return undefined
  return { name, rawInput: line.slice(match[0].length) }
}

/**
 * Decide whether Enter executes a host command or falls through to session.prompt.
 * Input commands accept bare and argued lines. Bare commands execute only as a bare
 * token; trailing input deliberately falls through to the model/skill admission path.
 */
export function adjudicateCommandLine(
  draft: string,
  commands: readonly CommandEntry[],
): CommandDisposition {
  const trimmed = draft.trim()
  const parsed = parseCommand(trimmed)
  if (parsed === undefined) return { kind: 'prompt' }
  const command = commands.find((entry) => entry.name === parsed.name)
  if (command === undefined) return { kind: 'prompt' }
  const bare = parsed.rawInput === ''
  if (command.input === undefined && !bare) return { kind: 'prompt' }
  return {
    kind: 'execute',
    line: command.input === undefined ? trimmed : draft.trimStart(),
    command,
  }
}

/** Extract the single text draft eligible for slash adjudication.
 *  多个 text part 无法用空格无损重写回一条命中行——直接放行 prompt，绝不据此 execute。 */
export function commandDraftOf(parts: readonly { type: string; text?: string }[], hasAttachments: boolean): string | null {
  if (hasAttachments) return null
  const textParts = parts.filter((part): part is { type: 'text'; text: string } => part.type === 'text' && typeof part.text === 'string')
  if (textParts.length !== 1) return null
  const text = textParts[0]!.text
  return text.trim().startsWith('/') ? text : null
}

/**
 * 在命令目录健康度已知时决定 Enter 的处置。优先 host command；command/skill 同名时
 * command 优先。
 *
 * 目录故障（commandLoadError !== null）时采用上游 ui-commands 的权威语义：
 * ui-commands registration 在 ui-skill 之前，controller.adjudicate 对 source
 * warmup rejection 直接 reject——因此任何 parseCommand 可识别的 slash 都返回
 * unavailable（报错并保留输入），绝不落 prompt。skills 不参与该判定，仅由调用方在
 * 当前 session 匹配 skillsSessionId 时传入（保留签名以对齐运行时数据流）。
 */
export function resolveCommandDisposition(
  draft: string,
  commands: readonly CommandEntry[],
  commandLoadError: string | null,
  skills: readonly SkillEntry[],
): CommandDisposition {
  const trimmed = draft.trim()
  const parsed = parseCommand(trimmed)
  if (parsed === undefined) return { kind: 'prompt' }
  if (commandLoadError !== null) {
    return { kind: 'unavailable', name: parsed.name }
  }
  return adjudicateCommandLine(trimmed, commands)
}
