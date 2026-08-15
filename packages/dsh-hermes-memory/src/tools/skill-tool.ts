/**
 * skill_manage 工具 — 程序性记忆（可复用流程）管理。
 * 移植自 pi-hermes-memory/src/tools/skill-tool.ts（MIT）。
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { lossless } from './lossless.ts'
import * as path from 'node:path'
import { SKILL_TOOL_DESCRIPTION } from '../constants.ts'
import { detectProject } from '../project.ts'
import type { HermesRuntime } from '../runtime.ts'
import type { SkillResult, SkillScope } from '../types.ts'
import { cwdFromExec } from './memory-tool.ts'

function normalizeTextList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
}

function formatOrderedList(items: string[]): string {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n')
}

function formatBulletList(items: string[], fallback: string): string {
  if (items.length === 0) return `- ${fallback}`
  return items.map((item) => `- ${item}`).join('\n')
}

function buildStructuredSkillBody(
  whenToUse: string,
  procedureSteps: string[],
  pitfalls: string[],
  verificationSteps: string[],
): string {
  return [
    '## When to Use',
    whenToUse,
    '',
    '## Procedure',
    formatOrderedList(procedureSteps),
    '',
    '## Pitfalls',
    formatBulletList(pitfalls, 'No notable pitfalls recorded yet.'),
    '',
    '## Verification',
    formatOrderedList(verificationSteps),
  ].join('\n')
}

/** skill_manage 工具参数。 */
export interface SkillToolArgs {
  action: 'create' | 'view' | 'patch' | 'update' | 'edit' | 'delete'
  name?: string
  skill_id?: string
  description?: string
  scope?: SkillScope
  section?: string
  content?: string
  when_to_use?: string
  procedure_steps?: unknown
  pitfalls?: unknown
  verification_steps?: unknown
}

/** 渲染技能操作结果。 */
export function formatSkillResult(result: SkillResult): string {
  return JSON.stringify(result)
}

/**
 * 注册 skill_manage 工具。
 * @param ctx - 插件上下文
 * @param runtime - 插件运行时
 */
export function registerSkillTool(ctx: Context, runtime: HermesRuntime): void {
  const { skillStore, config, projectsRoot } = runtime

  /** 从 cwd 同步项目上下文（create/move 到 project 作用域需要）。 */
  const syncProjectContext = (cwd: string | undefined): void => {
    const project = detectProject(config.projectsMemoryDir, cwd)
    if (project.name && project.memoryDir) {
      skillStore.setProjectContext(project.name, path.join(projectsRoot, project.name, 'skills'))
    } else {
      skillStore.setProjectContext(null, null)
    }
  }

  ctx.tools.register(defineTool({
    name: 'skill_manage',
    description: SKILL_TOOL_DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        enum: ['create', 'view', 'patch', 'update', 'edit', 'delete'],
        required: true,
        description: 'The skill action to perform.',
      },
      name: { type: 'string', description: "Skill name for create. e.g., 'debug-typescript-errors'." },
      skill_id: {
        type: 'string',
        description: "Stable skill id for view/patch/update/delete. e.g., 'global:debug-typescript-errors' or 'project:my-repo:release-app'. Legacy alias 'edit' also accepts this field.",
      },
      description: { type: 'string', description: 'One-line description of when to use this skill. Required for create; optional for update/edit.' },
      scope: {
        type: 'string',
        enum: ['global', 'project'],
        description: "Required for create. Use 'global' for portable procedures and 'project' for repo-specific workflows.",
      },
      section: {
        type: 'string',
        description: "Required for patch. Section header to patch. e.g., 'Procedure', 'Pitfalls', 'Verification', 'When to Use'.",
      },
      content: {
        type: 'string',
        description: 'Raw markdown body for create/update/edit, or Markdown section body for patch. Prefer structured fields over free-form content when possible. For patch, JSON arrays are auto-coerced for list sections; JSON objects are rejected.',
      },
      when_to_use: { type: 'string', description: "Structured create/update/edit field, or structured patch body when section is 'When to Use'." },
      procedure_steps: {
        type: 'array',
        items: { type: 'string' },
        description: "Structured create/update/edit field, or structured patch body when section is 'Procedure'. Ordered concrete steps.",
      },
      pitfalls: {
        type: 'array',
        items: { type: 'string' },
        description: "Structured create/update/edit field, or structured patch body when section is 'Pitfalls'.",
      },
      verification_steps: {
        type: 'array',
        items: { type: 'string' },
        description: "Structured create/update/edit field, or structured patch body when section is 'Verification'.",
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text' as const, text: formatSkillResult(value as unknown as SkillResult) }],
    },
    async execute(args, exec) {
      const skillParams = args as SkillToolArgs
      const {
        action,
        name,
        skill_id,
        description,
        scope,
        section,
        content,
        when_to_use,
        procedure_steps,
        pitfalls,
        verification_steps,
      } = skillParams

      const whenToUse = typeof when_to_use === 'string' ? when_to_use.trim() : ''
      const procedureSteps = normalizeTextList(procedure_steps)
      const pitfallItems = normalizeTextList(pitfalls)
      const verificationSteps = normalizeTextList(verification_steps)
      const hasStructuredBody = Boolean(whenToUse) || procedureSteps.length > 0 || pitfallItems.length > 0 || verificationSteps.length > 0

      const buildBodyOrError = (): { body: string } | { error: string } => {
        if (content?.trim()) return { body: content.trim() }
        if (!hasStructuredBody) {
          return {
            error: 'Either content or structured fields are required. Prefer when_to_use, procedure_steps, pitfalls, and verification_steps for create/update.',
          }
        }
        if (!whenToUse) {
          return { error: 'when_to_use is required when content is omitted.' }
        }
        if (procedureSteps.length === 0) {
          return { error: 'procedure_steps is required when content is omitted.' }
        }
        if (verificationSteps.length === 0) {
          return { error: 'verification_steps is required when content is omitted.' }
        }
        return {
          body: buildStructuredSkillBody(whenToUse, procedureSteps, pitfallItems, verificationSteps),
        }
      }

      const fail = (error: string) => lossless({ success: false, error })

      syncProjectContext(cwdFromExec(exec))
      let result: SkillResult
      switch (action) {
        case 'create': {
          if (!name) return fail("name is required for 'create' action.")
          if (!description) return fail("description is required for 'create' action.")
          const createBodyResult = buildBodyOrError()
          if ('error' in createBodyResult) return fail(createBodyResult.error)
          if (!scope) {
            return fail("scope is required for 'create' action. Use 'global' or 'project'.")
          }
          result = await skillStore.create(name, description, createBodyResult.body, scope)
          break
        }

        case 'view': {
          if (!skill_id) {
            const index = await skillStore.loadIndex()
            return lossless({ success: true, skills: index })
          }
          const doc = await skillStore.loadSkill(skill_id)
          if (!doc) {
            return fail(`Skill '${skill_id}' not found.`)
          }
          return lossless({ success: true, ...doc })
        }

        case 'patch': {
          if (!skill_id) return fail("skill_id is required for 'patch' action.")
          if (!section) return fail("section is required for 'patch' action.")

          const sectionKey = section.replace(/^#+\s*/, '').trim().toLowerCase()
          let patchContent = content?.trim() ?? ''

          // 优先用与目标段匹配的结构化字段，LLM 不必自己编 Markdown 列表格式。
          if (sectionKey === 'procedure' && procedureSteps.length > 0) {
            patchContent = formatOrderedList(procedureSteps)
          } else if (sectionKey === 'pitfalls' && pitfallItems.length > 0) {
            patchContent = formatBulletList(pitfallItems, 'No notable pitfalls recorded yet.')
          } else if (sectionKey === 'verification' && verificationSteps.length > 0) {
            patchContent = formatOrderedList(verificationSteps)
          } else if ((sectionKey === 'when to use' || sectionKey === 'when_to_use') && whenToUse) {
            patchContent = whenToUse
          } else if (!patchContent && hasStructuredBody) {
            // 段名非标准时也允许单个结构化字段。
            if (procedureSteps.length > 0 && pitfallItems.length === 0 && verificationSteps.length === 0 && !whenToUse) {
              patchContent = formatOrderedList(procedureSteps)
            } else if (pitfallItems.length > 0 && procedureSteps.length === 0 && verificationSteps.length === 0 && !whenToUse) {
              patchContent = formatBulletList(pitfallItems, 'No notable pitfalls recorded yet.')
            } else if (verificationSteps.length > 0 && procedureSteps.length === 0 && pitfallItems.length === 0 && !whenToUse) {
              patchContent = formatOrderedList(verificationSteps)
            } else if (whenToUse && procedureSteps.length === 0 && pitfallItems.length === 0 && verificationSteps.length === 0) {
              patchContent = whenToUse
            } else {
              return fail('For patch, provide content or exactly one structured field matching the target section (procedure_steps, pitfalls, verification_steps, or when_to_use). Use update for multi-section rewrites.')
            }
          }

          if (!patchContent) {
            return fail('content or a matching structured field is required for \'patch\' action. Prefer procedure_steps/pitfalls/verification_steps/when_to_use.')
          }

          result = await skillStore.patch(skill_id, section, patchContent)
          break
        }

        case 'update':
        case 'edit': {
          const updateActionLabel = action === 'edit' ? 'edit' : 'update'
          if (!skill_id) return fail(`skill_id is required for '${updateActionLabel}' action.`)
          const updateBodyResult = buildBodyOrError()
          const nextDescription = description?.trim() || ''
          const nextBody = 'body' in updateBodyResult ? updateBodyResult.body : (content?.trim() ?? '')
          if (!nextDescription && !nextBody) {
            return fail(`Provide description, content, or structured fields for '${updateActionLabel}'.`)
          }
          if (hasStructuredBody && 'error' in updateBodyResult) {
            return fail(updateBodyResult.error)
          }
          result = await skillStore.edit(skill_id, nextDescription, nextBody)
          break
        }

        case 'delete': {
          if (!skill_id) return fail("skill_id is required for 'delete' action.")
          result = await skillStore.delete(skill_id)
          break
        }

        default:
          return fail(`Unknown action '${action}'. Use: create, view, patch, update, delete`)
      }

      return lossless(result)
    },
  }))
}
