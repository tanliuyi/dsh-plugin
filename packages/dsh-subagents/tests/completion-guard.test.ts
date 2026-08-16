/**
 * completion-guard 单元测试（对齐上游 pi-subagents src/runs/shared/completion-guard.ts
 * 的语义；dsh 用 tool/call 事件观察替代上游消息流检测）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  COMPLETION_GUARD_ERROR,
  evaluateCompletionMutationGuard,
  hasMutationToolCapability,
  isMutatingToolName,
  mutationToolNameFromEvent,
} from '../src/runs/completion-guard.ts'
import { classifyTaskMutationIntent, expectsImplementationMutation, taskMayMutate } from '../src/runs/task-intent.ts'

test('hasMutationToolCapability: undefined 视为具备', () => {
  assert.equal(hasMutationToolCapability(undefined), true)
})

test('hasMutationToolCapability: 全只读工具无 mutation 能力', () => {
  assert.equal(hasMutationToolCapability(['read', 'grep', 'ls', 'web_search']), false)
})

test('hasMutationToolCapability: 含写工具具备能力', () => {
  assert.equal(hasMutationToolCapability(['read', 'edit']), true)
})

test('isMutatingToolName: 写工具识别', () => {
  assert.equal(isMutatingToolName('edit'), true)
  assert.equal(isMutatingToolName('write'), true)
  assert.equal(isMutatingToolName('bash'), true)
  assert.equal(isMutatingToolName('read'), false)
  assert.equal(isMutatingToolName('grep'), false)
  assert.equal(isMutatingToolName(''), false)
})

test('evaluateCompletionMutationGuard: 实现任务无写调用 → triggered', () => {
  const r = evaluateCompletionMutationGuard({
    agent: 'worker',
    task: 'Fix the failing test in src/foo.test.ts',
    tools: ['read', 'edit', 'bash'],
    observedMutationTools: [],
  })
  assert.equal(r.expectedMutation, true)
  assert.equal(r.attemptedMutation, false)
  assert.equal(r.triggered, true)
})

test('evaluateCompletionMutationGuard: 实现任务有写调用 → 不触发', () => {
  const r = evaluateCompletionMutationGuard({
    agent: 'worker',
    task: 'Fix the failing test in src/foo.test.ts',
    tools: ['read', 'edit', 'bash'],
    observedMutationTools: ['edit'],
  })
  assert.equal(r.expectedMutation, true)
  assert.equal(r.attemptedMutation, true)
  assert.equal(r.triggered, false)
})

test('evaluateCompletionMutationGuard: 只读任务不触发', () => {
  const r = evaluateCompletionMutationGuard({
    agent: 'reviewer',
    task: 'Review the changes and return findings only',
    tools: ['read', 'grep'],
    observedMutationTools: [],
  })
  assert.equal(r.expectedMutation, false)
  assert.equal(r.triggered, false)
})

test('evaluateCompletionMutationGuard: 明确禁止修改不触发', () => {
  const r = evaluateCompletionMutationGuard({
    agent: 'worker',
    task: 'Do not modify any files; report what you find',
    tools: ['read', 'edit', 'bash'],
    observedMutationTools: [],
  })
  assert.equal(r.expectedMutation, false)
  assert.equal(r.triggered, false)
})

test('task-intent: 实现/只读/未知分类', () => {
  assert.equal(expectsImplementationMutation('worker', 'Implement the fix for bug #42'), true)
  assert.equal(expectsImplementationMutation('worker', 'Update src/config.ts to add the new option'), true)
  assert.equal(expectsImplementationMutation('scout', 'Investigate the codebase structure'), false)
  assert.equal(expectsImplementationMutation('oracle', 'Give a second opinion on the design'), false)
  assert.equal(classifyTaskMutationIntent('worker', 'Do not edit anything').kind, 'read-only')
  assert.equal(taskMayMutate('Write a summary report of findings'), false)
  assert.equal(taskMayMutate('fix the build failure'), true)
})

test('COMPLETION_GUARD_ERROR 文案对齐上游', () => {
  assert.equal(COMPLETION_GUARD_ERROR, 'Subagent completed without making edits for an implementation task.')
})

// ─── mutationToolNameFromEvent：跨执行模式的 mutation 检测回归 ───────────────────
// 缺陷：#288 completion-guard 假阴性——外层 worker 以 code 模式（run_code）执行嵌套
// 工具调用时，spawn.ts 只观察 tool/call 的 data.name（= 'run_code'，非变更），导致
// observedMutationTools 一直为空、实现类任务被误判为「未做任何编辑」。此处镜像真实
// 失败会话的 event 载荷：外层 tool/call name=run_code，嵌套 tool/code-dispatch 携带
// data{ name:'edit', isError:false, subCallId }。

test('mutationToolNameFromEvent: 普通模式（外层 tool/call）直接 edit → 变更', () => {
  assert.equal(
    mutationToolNameFromEvent({ type: 'tool/call', data: { name: 'edit', callId: 'c1' } }),
    'edit',
  )
})

test('mutationToolNameFromEvent: 普通模式 read → 非变更', () => {
  assert.equal(
    mutationToolNameFromEvent({ type: 'tool/call', data: { name: 'read', callId: 'c1' } }),
    null,
  )
})

test('mutationToolNameFromEvent: code 模式外层 run_code 单独出现 → 非变更（不把 run_code 自身当 mutation）', () => {
  assert.equal(
    mutationToolNameFromEvent({ type: 'tool/call', data: { name: 'run_code', callId: 'c1' } }),
    null,
  )
})

test('mutationToolNameFromEvent: code 模式成功嵌套 edit → 变更（真实失败会话载荷）', () => {
  assert.equal(
    mutationToolNameFromEvent({ type: 'tool/code-dispatch', data: { name: 'edit', isError: false, subCallId: 'sc-9' } }),
    'edit',
  )
})

test('mutationToolNameFromEvent: code 模式成功嵌套 write → 变更', () => {
  assert.equal(
    mutationToolNameFromEvent({ type: 'tool/code-dispatch', data: { name: 'write', isError: false, subCallId: 'sc-1' } }),
    'write',
  )
})

test('mutationToolNameFromEvent: code 模式成功嵌套 bash → 变更', () => {
  assert.equal(
    mutationToolNameFromEvent({ type: 'tool/code-dispatch', data: { name: 'bash', isError: false, subCallId: 'sc-2' } }),
    'bash',
  )
})

test('mutationToolNameFromEvent: code 模式失败嵌套 edit（isError=true）→ 不计', () => {
  assert.equal(
    mutationToolNameFromEvent({ type: 'tool/code-dispatch', data: { name: 'edit', isError: true, subCallId: 'sc-3' } }),
    null,
  )
})

test('mutationToolNameFromEvent: code 模式只读嵌套（read/grep）→ 不计', () => {
  assert.equal(
    mutationToolNameFromEvent({ type: 'tool/code-dispatch', data: { name: 'read', isError: false, subCallId: 'sc-4' } }),
    null,
  )
  assert.equal(
    mutationToolNameFromEvent({ type: 'tool/code-dispatch', data: { name: 'grep', isError: true, subCallId: 'sc-5' } }),
    null,
  )
})

test('mutationToolNameFromEvent: 其他事件类型 / 缺 data → null', () => {
  assert.equal(mutationToolNameFromEvent({ type: 'turn/start' }), null)
  assert.equal(mutationToolNameFromEvent({ type: 'tool/code-dispatch' }), null)
  assert.equal(mutationToolNameFromEvent({ type: '' }), null)
  assert.equal(mutationToolNameFromEvent(undefined as never), null)
  assert.equal(mutationToolNameFromEvent({ type: 'tool/code-dispatch', data: { name: '', isError: false } }), null)
})
