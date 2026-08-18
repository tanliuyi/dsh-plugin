import test from 'node:test'
import assert from 'node:assert/strict'

import { ConversationFold, foldHistory, type DshMessage, type FoldableSessionEvent } from '../web/src/dsh/messages.ts'

const ev = (seq: number, type: string, data: unknown, extra: Record<string, unknown> = {}): FoldableSessionEvent => ({
  type,
  seq,
  time: seq * 100,
  data,
  ...extra,
})

/** 上游 user/message.data：{ id, role?, source: {kind:'user'}, content }。 */
const userMessage = (id: string, text: string): Record<string, unknown> => ({
  id,
  source: { kind: 'user' },
  content: [{ type: 'text', text }],
})

const nextStep = (
  seq: number,
  opts: { start?: number; removedCount?: number; inserted?: { id: string }[]; outcome?: 'canceled' } = {},
): FoldableSessionEvent =>
  ev(seq, 'agent/inbox/spliced', {
    target: 'next-step',
    start: opts.start ?? 0,
    ...(opts.removedCount !== undefined ? { removedCount: opts.removedCount } : {}),
    inserted: opts.inserted ?? [],
    ...(opts.outcome !== undefined ? { outcome: opts.outcome } : {}),
  })

const nextTurn = (seq: number, opts: { start?: number; removedCount?: number; inserted?: { id: string }[] } = {}): FoldableSessionEvent =>
  ev(seq, 'agent/inbox/spliced', {
    target: 'next-turn',
    start: opts.start ?? 0,
    ...(opts.removedCount !== undefined ? { removedCount: opts.removedCount } : {}),
    inserted: opts.inserted ?? [],
  })

/** 提取 text / steering part 的纯文字（排除 context 等非正文 part）。 */
const partTexts = (messages: DshMessage[]): string[] =>
  messages.map((message) =>
    message.parts
      .map((part) => (part.type === 'text' || part.type === 'steering' ? part.text : ''))
      .join(''),
  )

interface FoldRun {
  events: FoldableSessionEvent[]
  roles: ('user' | 'assistant' | 'steering')[]
  texts?: string[]
}

interface SteeringCase {
  name: string
  /** 每个 run 用独立 ConversationFold：证明 fold context 是会话隔离的，无共享状态。 */
  runs: FoldRun[]
}

const steeringCases: SteeringCase[] = [
  {
    name: '普通 source user => user',
    runs: [
      {
        events: [ev(1, 'user/message', userMessage('u-1', 'hello'))],
        roles: ['user'],
        texts: ['hello'],
      },
    ],
  },
  {
    name: 'next-step claimed => steering 非 user',
    runs: [
      {
        events: [
          nextStep(1, { inserted: [{ id: 's-1' }] }),
          nextStep(2, { removedCount: 1 }),
          ev(3, 'user/message', userMessage('s-1', 'change direction')),
        ],
        roles: ['steering'],
        texts: ['change direction'],
      },
    ],
  },
  {
    name: 'canceled removal 不 claim => user',
    runs: [
      {
        events: [
          nextStep(1, { inserted: [{ id: 's-c' }] }),
          nextStep(2, { removedCount: 1, outcome: 'canceled' }),
          ev(3, 'user/message', userMessage('s-c', 'dropped')),
        ],
        roles: ['user'],
        texts: ['dropped'],
      },
    ],
  },
  {
    name: 'inserted 重新清 claim => user',
    runs: [
      {
        events: [
          nextStep(1, { inserted: [{ id: 's-1' }] }), // pending [s-1]
          nextStep(2, { removedCount: 1 }), // claimed {s-1}
          nextStep(3, { inserted: [{ id: 's-1' }] }), // 重新入队 → claimed 清空
          ev(4, 'user/message', userMessage('s-1', 're-queued')),
        ],
        roles: ['user'],
        texts: ['re-queued'],
      },
    ],
  },
  {
    name: 'next-turn 的移除不影响 next-step claim',
    runs: [
      {
        events: [
          nextTurn(1, { inserted: [{ id: 's-2' }] }),
          nextTurn(2, { removedCount: 1 }),
          ev(3, 'user/message', userMessage('s-2', 'queued-turn input')),
        ],
        roles: ['user'],
        texts: ['queued-turn input'],
      },
      {
        events: [
          nextStep(1, { inserted: [{ id: 's-3' }] }),
          nextTurn(2, { removedCount: 1 }), // next-turn 移除不影响 next-step pending
          nextStep(3, { removedCount: 1 }),
          ev(4, 'user/message', userMessage('s-3', 'step input')),
        ],
        roles: ['steering'],
        texts: ['step input'],
      },
    ],
  },
  {
    name: '不同 fold context 隔离（同 id 不同判定）',
    runs: [
      {
        events: [
          nextStep(1, { inserted: [{ id: 'x' }] }),
          nextStep(2, { removedCount: 1 }),
          ev(3, 'user/message', userMessage('x', 'in A')),
        ],
        roles: ['steering'],
        texts: ['in A'],
      },
      {
        events: [ev(1, 'user/message', userMessage('x', 'in B'))],
        roles: ['user'],
        texts: ['in B'],
      },
    ],
  },
  {
    name: 'replacement surface 不显示',
    runs: [
      {
        events: [
          ev(1, 'user/message', userMessage('r-1', 'model-only checkpoint'), {
            surfaceOp: { op: 'replace', start: 1, end: 1 },
          }),
        ],
        roles: [],
      },
    ],
  },
]

for (const c of steeringCases) {
  test(`steering fold: ${c.name}`, () => {
    for (const run of c.runs) {
      // 每个 run 独立实例：即便前一个 run 有 claim，新实例也绝不受影响。
      const folder = new ConversationFold()
      for (const event of run.events) folder.fold(event)
      const messages = folder.getMessages()
      assert.deepEqual(
        messages.map((message) => message.role),
        run.roles,
        `roles mismatch for run: ${run.events.map((e) => `${e.seq}:${e.type}`).join(', ')}`,
      )
      assert.equal(messages.length, run.texts?.length ?? run.roles.length, 'message count mismatch')
      if (run.texts) {
        assert.deepEqual(partTexts(messages), run.texts, 'text mismatch')
      }
    }
  })
}

test('foldHistory 重放重建 steering 状态（history 与 live 一致）', () => {
  const history = [
    nextStep(1, { inserted: [{ id: 's-1' }] }),
    nextStep(2, { removedCount: 1 }),
    ev(3, 'user/message', userMessage('s-1', 'steer from history')),
  ]
  const messages = foldHistory(history)
  assert.deepEqual(
    messages.map((message) => message.role),
    ['steering'],
  )
  assert.deepEqual(partTexts(messages), ['steer from history'])
  assert.equal(messages[0]!.parts[0]!.type, 'steering')
})

test('live buffer 与 history 按 seq 去重合并，steering 状态延续', () => {
  const folder = new ConversationFold()
  // 模拟 openSession：先重放 history。
  for (const event of [
    nextStep(1, { inserted: [{ id: 's-1' }] }),
    nextStep(2, { removedCount: 1 }),
    ev(3, 'user/message', userMessage('s-1', 'steer')),
  ]) {
    folder.fold(event)
  }
  assert.deepEqual(folder.getMessages().map((message) => message.role), ['steering'])

  // history 里已有的 seq 重放被去重丢弃。
  const duplicate = folder.fold(ev(3, 'user/message', userMessage('s-1', 'dup replay')))
  assert.equal(duplicate, null)
  assert.equal(folder.getMessages().length, 1)

  // 后续 live 事件继续折入同一状态（按 seq 顺序，与 handleMuxEvent 一致）。
  folder.fold(ev(4, 'user/message', userMessage('u-live', 'first')))
  folder.fold(ev(5, 'user/message', userMessage('u-live-2', 'second')))
  assert.deepEqual(folder.getMessages().map((message) => message.role), ['steering', 'user', 'user'])
  assert.deepEqual(partTexts(folder.getMessages()), ['steer', 'first', 'second'])
})
