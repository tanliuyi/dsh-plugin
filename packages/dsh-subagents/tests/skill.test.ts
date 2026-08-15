import { test } from 'node:test'
import assert from 'node:assert/strict'

import { registerSubagentsSkill } from '../src/skill.ts'

test('skill registration satisfies the dsh-skill contract (source AND content)', () => {
  let registered: Record<string, unknown> | undefined
  const disposer = () => {}
  const ctx = {
    get: (name: string) => {
      assert.equal(name, 'skills')
      return {
        register: (skill: unknown) => {
          registered = skill as Record<string, unknown>
          return disposer
        },
      }
    },
  }

  const result = registerSubagentsSkill(ctx as never)
  assert.ok(registered, 'skill must be registered when ctx.skills exists')
  // validateDefinition 要求 source 与 content 都必须是字符串，缺任一即加载失败
  assert.equal(typeof registered!['source'], 'string', 'source must be a string (loaded skill "..." source must be a string)')
  assert.equal(typeof registered!['content'], 'string', 'content must be a string (loaded skill "..." content must be a string)')
  assert.ok((registered!['source'] as string).includes('Subagents'))
  assert.ok((registered!['content'] as string).includes('Subagents'))
  assert.equal(registered!['name'], 'subagents')
  assert.ok((registered!['resourceBase'] as { kind: string }).kind === 'directory')
  assert.equal(result, disposer)
})

test('skill registration is a no-op when ctx.skills is absent', () => {
  const ctx = { get: () => undefined }
  const result = registerSubagentsSkill(ctx as never)
  assert.equal(typeof result, 'function', 'absent skills service must yield a no-op disposer')
})
