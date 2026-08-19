import test from 'node:test'
import assert from 'node:assert/strict'

import { progressLabel, todoListItemsOf, todoSummaryOf } from '../web/src/components/assistant-ui/todo-model.ts'
import type { TodoItem } from '../web/src/dsh/api.ts'
import { todosFromEvents } from '../web/src/dsh/store.ts'

const LIST: TodoItem[] = [
  { content: '搭骨架', status: 'completed' },
  { content: '写组件', status: 'in_progress' },
  { content: '补测试', status: 'pending' },
]

const PARALLEL: TodoItem[] = [
  { content: '搭骨架', status: 'completed' },
  { content: '写组件', status: 'in_progress' },
  { content: '跑后台构建', status: 'in_progress' },
  { content: '读源码', status: 'in_progress' },
  { content: '补测试', status: 'pending' },
]

test('todo panel progress omits zero-count statuses and counts parallel work', () => {
  assert.equal(progressLabel(LIST), '1 已完成\u2002·\u20021 进行中\u2002·\u20021 待处理')
  assert.equal(progressLabel(PARALLEL), '1 已完成\u2002·\u20023 进行中\u2002·\u20021 待处理')
  assert.equal(progressLabel([{ content: '完成', status: 'completed' }]), '1 已完成')
})

test('todo panel maps dsh statuses to assistant-ui statuses with stable ids', () => {
  assert.deepEqual(todoListItemsOf(LIST), [
    { id: '0:搭骨架', text: '搭骨架', status: 'done' },
    { id: '1:写组件', text: '写组件', status: 'active' },
    { id: '2:补测试', text: '补测试', status: 'pending' },
  ])
})

test('todo tool summary keeps the parallel active count separate', () => {
  assert.deepEqual(todoSummaryOf(PARALLEL), {
    done: 1,
    total: 5,
    activeContent: '写组件',
    activeExtra: 2,
  })
  assert.deepEqual(todoSummaryOf([{ content: '完成', status: 'completed' }]), {
    done: 1,
    total: 1,
    activeContent: null,
    activeExtra: 0,
  })
})

test('todo tool summary does not invent an active hint for unusable content', () => {
  assert.deepEqual(todoSummaryOf([
    { content: '   ', status: 'in_progress' },
    { content: '另一个任务', status: 'in_progress' },
  ]), {
    done: 0,
    total: 2,
    activeContent: null,
    activeExtra: 0,
  })
})

test('todo event fallback clears on turn start and restores the latest whole-list write', () => {
  const event = (seq: number, type: string, data: unknown) => ({
    type,
    seq,
    time: seq * 100,
    data,
  })
  assert.deepEqual(todosFromEvents([
    event(2, 'todo/write', { todos: LIST }),
    event(3, 'turn/start', {}),
  ]), null)
  assert.deepEqual(todosFromEvents([
    event(1, 'turn/start', {}),
    event(2, 'todo/write', { todos: PARALLEL }),
  ]), PARALLEL)
  assert.equal(todosFromEvents([event(1, 'assistant/message', {})]), undefined)
})

test('todo history merge applies only events newer than the projection watermark', () => {
  const event = (seq: number, type: string, data: unknown) => ({
    type,
    seq,
    time: seq * 100,
    data,
  })
  const baseline = [{ content: 'baseline', status: 'pending' as const }]
  assert.deepEqual(todosFromEvents([
    event(4, 'todo/write', { todos: [{ content: 'old', status: 'completed' }] }),
    event(6, 'todo/write', { todos: [{ content: 'new', status: 'in_progress' }] }),
  ], baseline, 5), [{ content: 'new', status: 'in_progress' }])
  assert.deepEqual(todosFromEvents([
    event(4, 'turn/start', {}),
  ], baseline, 5), baseline)
})
