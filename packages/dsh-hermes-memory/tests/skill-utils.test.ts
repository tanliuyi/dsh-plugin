import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  buildSkillId,
  formatFrontmatter,
  jaccardSimilarity,
  parseFrontmatter,
  parseSkillId,
  slugify,
  tokenizeForSimilarity,
} from '../src/store/skill-utils.ts'

test('slugify produces kebab-case slugs', () => {
  assert.equal(slugify('Debug TypeScript Errors!'), 'debug-typescript-errors')
  assert.equal(slugify('  Release   App  '), 'release-app')
  assert.equal(slugify('中文技能名'), '')
  assert.equal(slugify('a'.repeat(100)).length <= 64, true)
})

test('parseFrontmatter extracts meta and body', () => {
  const raw = '---\nname: "debug-ts"\ndescription: "Debug TS"\nversion: 1\n---\n\n## Procedure\n1. Run tsc'
  const parsed = parseFrontmatter(raw)
  assert.equal(parsed.meta.name, 'debug-ts')
  assert.equal(parsed.meta.version, '1')
  assert.equal(parsed.body, '## Procedure\n1. Run tsc')
})

test('formatFrontmatter round-trips through parseFrontmatter', () => {
  const doc = {
    name: 'debug-ts',
    displayName: 'Debug TS',
    description: 'Debug TypeScript build failures',
    version: 2,
    created: '2026-01-01',
    updated: '2026-01-02',
    body: '## When to Use\nTS fails.',
  }
  const formatted = formatFrontmatter(doc)
  const parsed = parseFrontmatter(formatted)
  assert.equal(parsed.meta.name, 'debug-ts')
  assert.equal(parsed.meta.display_name, 'Debug TS')
  assert.equal(parsed.meta.version, '2')
  assert.equal(parsed.body, '## When to Use\nTS fails.')
})

test('jaccardSimilarity and tokenizeForSimilarity', () => {
  const a = tokenizeForSimilarity('debug typescript errors monorepo')
  const b = tokenizeForSimilarity('debug typescript build errors')
  const same = tokenizeForSimilarity('debug typescript errors monorepo')
  assert.equal(jaccardSimilarity(a, same), 1)
  assert.ok(jaccardSimilarity(a, b) > 0)
  assert.equal(jaccardSimilarity(a, []), 0)
})

test('buildSkillId and parseSkillId round-trip', () => {
  assert.equal(buildSkillId('global', 'debug-ts'), 'global:debug-ts')
  assert.equal(buildSkillId('project', 'release-app', 'my-repo'), 'project:my-repo:release-app')

  const global = parseSkillId('global:debug-ts')!
  assert.equal(global.scope, 'global')
  assert.equal(global.slug, 'debug-ts')

  const project = parseSkillId('project:my-repo:release-app')!
  assert.equal(project.scope, 'project')
  assert.equal(project.projectName, 'my-repo')
  assert.equal(project.slug, 'release-app')

  assert.equal(parseSkillId('bogus'), null)
  assert.equal(parseSkillId('project:'), null)
})
