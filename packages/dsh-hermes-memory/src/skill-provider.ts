/**
 * dsh 技能提供者 — 把 SkillStore 的 SKILL.md 目录暴露给 `ctx.skills` 注册表。
 *
 * 上游通过 Pi 的 `resources_discover` 钩子贡献技能路径；dsh 用
 * `skills.registerProvider()` 注册一个提供者：list() 返回全局 + 当前项目
 * 技能候选，get() 读取 SKILL.md 正文。这样技能在 dsh 的技能目录、skill 工具
 * 与用户显式调用中都可被发现，且重启后依然存在（文件持久化）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillDefinition, SkillLookupOptions, SkillProvider } from '@deepseek-ai/dsh-skill'
import type { HermesRuntime } from './runtime.ts'
import { detectProjectSkills } from './project.ts'
import type { SkillIndex } from './types.ts'

/** 提供者名。 */
export const SKILL_PROVIDER_NAME = 'dsh-hermes-memory'

/**
 * 注册技能提供者。
 * @param ctx - 插件上下文
 * @param runtime - 插件运行时
 */
export function registerSkillProvider(ctx: Context, runtime: HermesRuntime): void {
  const skills = ctx.get('skills') as {
    registerProvider(create: (control: { signal: AbortSignal; invalidate: () => void }) => SkillProvider): unknown
  } | undefined
  if (skills === undefined) return

  const { skillStore } = runtime

  skills.registerProvider(() => ({
    name: SKILL_PROVIDER_NAME,

    async list(options: SkillLookupOptions): Promise<readonly SkillCandidate[]> {
      // cwd 决定当前项目；项目技能随项目上下文暴露。
      if (options.cwd) {
        const detected = detectProjectSkills(runtime.config.projectsMemoryDir, options.cwd)
        skillStore.setProjectContext(detected.name, detected.skillsDir)
      }
      const index = await skillStore.loadIndex()
      return index.map((skill) => toCandidate(skill))
    },

    async get(candidate: SkillCandidate, _options: SkillLookupOptions): Promise<SkillDefinition | undefined> {
      const skillId = typeof candidate.locator === 'string' ? candidate.locator : candidate.name
      const doc = await skillStore.loadSkill(skillId)
      if (!doc) return undefined
      return {
        name: doc.name,
        description: doc.description,
        whenToUse: undefined,
        invocation: { modelInvocable: true, userInvocable: true },
        source: doc.scope === 'global' ? 'user-dsh' : 'project-dsh',
        provider: SKILL_PROVIDER_NAME,
        content: doc.body,
        path: doc.path,
        metadata: {
          skillId: doc.skillId,
          scope: doc.scope,
          version: doc.version,
          created: doc.created,
          updated: doc.updated,
        },
      }
    },
  }))
}

function toCandidate(skill: SkillIndex): SkillCandidate {
  return {
    name: skill.name,
    description: skill.description,
    whenToUse: undefined,
    invocation: { modelInvocable: true, userInvocable: true },
    source: skill.scope === 'global' ? 'user-dsh' : 'project-dsh',
    provider: SKILL_PROVIDER_NAME,
    rank: 700,
    locator: skill.skillId,
    path: skill.path,
    metadata: undefined,
  }
}
