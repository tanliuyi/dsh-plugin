import test from 'node:test'
import assert from 'node:assert/strict'

import { adjudicateCommandLine, commandDraftOf, parseCommand, resolveCommandDisposition } from '../web/src/dsh/commands.ts'

const commands = [
  { name: 'compact', description: 'Compact context' },
  { name: 'goal', description: 'Set a goal', input: { hint: 'objective' } },
]

const skills = [
  { name: 'review-pr', description: 'Review a PR', modelInvocable: true },
  // goal 与 host command 同名：command 必须优先。
  { name: 'goal', description: 'skill shadowing the command', modelInvocable: true },
]

test('parseCommand matches the upstream grammar and preserves raw input', () => {
  assert.deepEqual(parseCommand('/goal  keep this '), { name: 'goal', rawInput: '  keep this ' })
  assert.deepEqual(parseCommand('/a-b_2\nnext'), { name: 'a-b_2', rawInput: '\nnext' })
  for (const line of ['/Goal', ' /goal', '/2goal', '/goal/path', '/goal🔥', '/']) {
    assert.equal(parseCommand(line), undefined, line)
  }
})

test('input commands execute with or without arguments', () => {
  assert.deepEqual(adjudicateCommandLine('/goal', commands), {
    kind: 'execute',
    line: '/goal',
    command: commands[1],
  })
  assert.deepEqual(adjudicateCommandLine('  /goal keep trailing  ', commands), {
    kind: 'execute',
    line: '/goal keep trailing  ',
    command: commands[1],
  })
})

test('bare commands execute only as a bare token', () => {
  assert.equal(adjudicateCommandLine('/compact', commands).kind, 'execute')
  assert.deepEqual(adjudicateCommandLine('/compact now', commands), { kind: 'prompt' })
})

test('unknown commands, skills, malformed names, and attachments fall through to prompt', () => {
  assert.deepEqual(adjudicateCommandLine('/review-pr skill args', commands), { kind: 'prompt' })
  assert.deepEqual(adjudicateCommandLine('/Goal objective', commands), { kind: 'prompt' })
  assert.equal(commandDraftOf([{ type: 'text', text: '/goal x' }], true), null)
  assert.equal(commandDraftOf([{ type: 'text', text: 'ordinary text' }], false), null)
  assert.equal(commandDraftOf([{ type: 'text', text: '/goal x' }], false), '/goal x')
})

test('multiple text parts are never space-rewritten into an executable slash draft', () => {
  // 两个独立 text part：空格重写会改变语义，必须放行 prompt。
  assert.equal(commandDraftOf([{ type: 'text', text: 'prefix' }, { type: 'text', text: '/goal x' }], false), null)
  assert.equal(
    commandDraftOf([{ type: 'text', text: '  ' }, { type: 'text', text: '/compact' }], false),
    null,
  )
  // 单个 text part 且无附件仍可执行。
  assert.equal(commandDraftOf([{ type: 'text', text: '/compact' }], false), '/compact')
})

test('healthy catalog resolves through the same adjudication, command wins over same-named skill', () => {
  assert.deepEqual(resolveCommandDisposition('/goal keep it', commands, null, skills), {
    kind: 'execute',
    line: '/goal keep it',
    command: commands[1],
  })
  assert.deepEqual(resolveCommandDisposition('/compact', commands, null, skills), {
    kind: 'execute',
    line: '/compact',
    command: commands[0],
  })
  // command/skill 同名：host command 优先（goal 是 command，不是 skill）。
  const disposition = resolveCommandDisposition('/goal', commands, null, skills)
  assert.equal(disposition.kind, 'execute')
  if (disposition.kind === 'execute') assert.equal(disposition.line, '/goal')
})

test('broken catalog: any parseCommand-recognizable slash is unavailable (input preserved)', () => {
  // 上游权威语义：ui-commands registration 在 ui-skill 之前，controller.adjudicate
  // 对 source warmup rejection 直接 reject——目录故障时任何可识别 slash 都报错保留输入，
  // 绝不落 prompt（含 skill 命中的 slash 与未知 slash）。
  assert.deepEqual(resolveCommandDisposition('/goal x', commands, 'catalog broken', skills), {
    kind: 'unavailable',
    name: 'goal',
  })
  // 明确 skill：目录已坏，同样 unavailable。
  assert.deepEqual(resolveCommandDisposition('/review-pr skill args', commands, 'catalog broken', skills), {
    kind: 'unavailable',
    name: 'review-pr',
  })
  // 明确 unknown slash：unavailable。
  assert.deepEqual(resolveCommandDisposition('/definitely-not-a-command x', commands, 'catalog broken', skills), {
    kind: 'unavailable',
    name: 'definitely-not-a-command',
  })
  // 目录故障且无缓存：任何 slash 同样 unavailable。
  assert.deepEqual(resolveCommandDisposition('/goal x', [], 'catalog broken', skills), {
    kind: 'unavailable',
    name: 'goal',
  })
  // 非 slash：prompt。
  assert.deepEqual(resolveCommandDisposition('plain message', commands, 'catalog broken', skills), { kind: 'prompt' })
})
