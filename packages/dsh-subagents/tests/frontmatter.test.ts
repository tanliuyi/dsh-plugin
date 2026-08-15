import { test } from 'node:test'
import assert from 'node:assert/strict'

import { parseFrontmatter, parseFrontmatterList, foldBlock, serializeAgentFile, parsePositiveInt, parseBool, parseJsonField } from '../src/agents/frontmatter.ts'

test('parseFrontmatter: flat keys and body', () => {
  const { frontmatter, body } = parseFrontmatter('---\nname: scout\ndescription: Fast recon\n---\n\nYou are a scout.')
  assert.equal(frontmatter['name'], 'scout')
  assert.equal(frontmatter['description'], 'Fast recon')
  assert.equal(body, 'You are a scout.')
})

test('parseFrontmatter: no frontmatter returns raw body', () => {
  const { frontmatter, body } = parseFrontmatter('just a body')
  assert.deepEqual(frontmatter, {})
  assert.equal(body, 'just a body')
})

test('parseFrontmatter: block list values', () => {
  const { frontmatter } = parseFrontmatter('---\ntools:\n  - read\n  - grep\n---\n')
  assert.equal(frontmatter['tools'], '- read\n- grep')
})

test('parseFrontmatter: folded block scalar', () => {
  const { frontmatter } = parseFrontmatter('---\ndescription: >-\n  long text\n  continued\n---\n')
  assert.equal(frontmatter['description'], 'long text continued')
})

test('parseFrontmatter: quoted values keep quotes stripped', () => {
  const { frontmatter } = parseFrontmatter("---\nname: 'quoted name'\n---\n")
  assert.equal(frontmatter['name'], 'quoted name')
})

test('parseFrontmatterList: comma and block forms', () => {
  assert.deepEqual(parseFrontmatterList('read, grep, find'), ['read', 'grep', 'find'])
  assert.deepEqual(parseFrontmatterList('- read\n- grep'), ['read', 'grep'])
  assert.equal(parseFrontmatterList(undefined), undefined)
})

test('foldBlock: preserves more-indented lines', () => {
  assert.equal(foldBlock('a\n    indented\nb'), 'a\n    indented\nb')
})

test('parsePositiveInt / parseBool / parseJsonField', () => {
  assert.equal(parsePositiveInt('300000'), 300000)
  assert.equal(parsePositiveInt('abc'), undefined)
  assert.equal(parseBool('true', false), true)
  assert.equal(parseBool(undefined, true), true)
  assert.deepEqual(parseJsonField('{"maxTurns": 20}'), { maxTurns: 20 })
  assert.equal(parseJsonField('not json'), undefined)
})

test('serializeAgentFile round-trip through parseFrontmatter', () => {
  const file = serializeAgentFile({
    name: 'scout',
    tools: ['read', 'grep'],
    thinking: 'low',
    disabled: false,
  }, 'You are a scout.')
  const { frontmatter, body } = parseFrontmatter(file)
  assert.equal(frontmatter['name'], 'scout')
  assert.equal(frontmatter['thinking'], 'low')
  assert.equal(frontmatter['disabled'], undefined)
  assert.equal(body, 'You are a scout.')
})
