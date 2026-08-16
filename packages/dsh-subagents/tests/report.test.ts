/**
 * report 工具（子代理反向回报通道）的单元测试：子作用域安装、schema/guidance
 * 兼容、reportFrom 投递与按父回合状态的动态投递策略选择。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  installReportTool,
  registerReportTool,
  resolveParentDelivery,
  REPORT_SECTION_ORDER,
  REPORT_SECTION_TEXT,
} from '../src/report.ts'
import type { SessionState } from '../src/runs/execution.ts'

interface FakeToolDef {
  name: string;
  description: string;
  parameters: unknown;
  output: {
    schema: unknown;
    render: (args: unknown, value: { messageId: string }) => unknown[];
  };
  execute: (args: { output: string }, exec: { agent?: Agent; signal: AbortSignal }) => Promise<unknown>;
}

/** 假子作用域上下文：捕获注册的工具/段落。 */
function fakeChildCtx() {
  const sections: Array<{ name: string; order: number; text: string }> = []
  let toolDef: FakeToolDef | undefined
  const disposed: string[] = []
  const childCtx = {
    systemPrompt: {
      section(opts: { name: string; order: number; text: string }) {
        sections.push(opts)
        return () => disposed.push('section:' + opts.name) as unknown as void
      },
    },
    tools: {
      register(def: FakeToolDef) {
        toolDef = def
        return () => disposed.push('tool:' + def.name) as unknown as void
      },
    },
  } as any
  return { childCtx, sections, getTool: () => toolDef, disposed }
}

function fakeSession(id: string, parentSession?: string): Session {
  return { id, header: { parentSession } } as unknown as Session
}

function fakeAgent(sessionId: string, parentSession?: string): Agent {
  return { session: fakeSession(sessionId, parentSession) } as unknown as Agent
}

test('installReportTool: 在子作用域注册 report 工具与 tool:report 段落（顺序 117）', () => {
  const f = fakeChildCtx()
  const dispose = installReportTool(f.childCtx, {} as never, () => 'wakeup')
  assert.equal(f.sections.length, 1)
  assert.equal(f.sections[0]!.name, 'tool:report')
  assert.equal(f.sections[0]!.order, REPORT_SECTION_ORDER)
  assert.equal(f.sections[0]!.text, REPORT_SECTION_TEXT)
  const tool = f.getTool()
  assert.ok(tool, 'report tool should be registered')
  assert.equal(tool!.name, 'report')
  assert.ok(tool!.description.includes('Report selected content to the agent that started you'))
  // schema 对齐上游：单一必填 output 字符串，输出返回稳定 messageId
  const params = tool!.parameters as {
    type: 'object'
    properties: { output: { type: string; description: string } }
    required: string[]
  }
  assert.equal(params.type, 'object')
  assert.equal(params.properties.output.type, 'string')
  assert.deepEqual(params.required, ['output'])
  const outSchema = tool!.output.schema as { properties: { messageId: { type: string } }; additionalProperties: boolean; required: string[] }
  assert.equal(outSchema.additionalProperties, false)
  assert.equal(outSchema.properties.messageId.type, 'string')
  assert.deepEqual(outSchema.required, ['messageId'])
  assert.ok(dispose instanceof Function)
  // 清理：调用 installReportTool 返回的 disposer，工具与段落两处注册都应撤回
  dispose()
  assert.deepEqual(f.disposed, ['tool:report', 'section:tool:report'])
})

test('installReportTool: execute 以解析器的 delivery 调 reportFrom，返回 messageId 并渲染', async () => {
  const f = fakeChildCtx()
  const delivered: Array<{ agent: Agent; content: unknown[]; options: { delivery: string; signal: AbortSignal } }> = []
  const ctx = {
    subagents: {
      reportFrom: async (agent: Agent, content: unknown[], options: { delivery: string; signal: AbortSignal }) => {
        delivered.push({ agent, content, options })
        return 'msg-1'
      },
    },
  } as never
  const signal = new AbortController().signal
  const child = fakeAgent('child-1')
  installReportTool(f.childCtx, ctx, (a) => (a === child ? 'wakeup' : 'quiet'))
  const tool = f.getTool()!
  const result = await tool.execute({ output: 'my final result' }, { agent: child, signal })
  assert.deepEqual(result, { messageId: 'msg-1' })
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0]!.options.delivery, 'wakeup')
  assert.equal(delivered[0]!.options.signal, signal)
  assert.deepEqual(delivered[0]!.content, [{ type: 'text', text: 'my final result' }])
  const block = tool.output.render({ output: 'x' }, { messageId: 'msg-1' }) as Array<{ type: string; text: string }>
  assert.equal(block[0]!.text, 'report accepted by the agent that started you as message msg-1')
})

test('installReportTool: 注册失败时回滚 prompt 段落', () => {
  const f = fakeChildCtx()
  f.childCtx.tools.register = () => { throw new Error('boom') }
  assert.throws(() => installReportTool(f.childCtx, {} as never, () => 'wakeup'), /boom/)
  assert.ok(f.disposed.includes('section:tool:report'), 'section should be rolled back')
})

test('resolveParentDelivery: 父回合开 → quiet，父回合关 → wakeup，父不可解析 → wakeup', () => {
  const activeTurns = new Map<string, boolean>()
  const sessionState = { isTurnOpen: (id: string) => activeTurns.get(id) === true } as SessionState
  // 子代理自身 header 携带 parentSession 即可解析，无需 sessions 注册表
  const child = fakeAgent('child-1', 'parent-1')
  activeTurns.set('parent-1', true)
  assert.equal(resolveParentDelivery(sessionState, child), 'quiet')
  activeTurns.set('parent-1', false)
  assert.equal(resolveParentDelivery(sessionState, child), 'wakeup')
  // 父不可解析（header 无 parentSession）→ 保守 wakeup
  assert.equal(resolveParentDelivery(sessionState, fakeAgent('orphan')), 'wakeup')
  assert.equal(resolveParentDelivery(sessionState, { session: {} } as never), 'wakeup')
  assert.equal(resolveParentDelivery(sessionState, {} as never), 'wakeup')
})

test('registerReportTool: 经 registerContinuableSetup 为每个子作用域安装 report 工具', () => {
  const childInstalls: Array<(childCtx: unknown) => void> = []
  let registrationDisposerInvoked = 0
  const ctx = {
    subagents: {
      registerContinuableSetup: (contribution: (childCtx: unknown) => void) => {
        childInstalls.push(contribution)
        return () => { registrationDisposerInvoked++ }
      },
    },
  } as never
  const activeTurns = new Map<string, boolean>()
  const sessionState = { isTurnOpen: (id: string) => activeTurns.get(id) === true } as SessionState
  const dispose = registerReportTool(ctx, sessionState)
  assert.ok(dispose instanceof Function)
  assert.equal(childInstalls.length, 1)
  // registerReportTool 应原样返回 registerContinuableSetup 的注册 disposer
  assert.equal(registrationDisposerInvoked, 0)
  dispose()
  assert.equal(registrationDisposerInvoked, 1)
  // 用假子作用域实例化贡献：工具应被注册
  const f = fakeChildCtx()
  childInstalls[0]!(f.childCtx)
  assert.ok(f.getTool(), 'report tool installed into child scope')
  assert.equal(f.getTool()!.name, 'report')
  assert.equal(f.sections[0]!.name, 'tool:report')
})