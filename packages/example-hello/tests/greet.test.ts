import { test } from 'node:test'
import assert from 'node:assert/strict'

import { name, apply } from '../src/index.ts'

/** 构造一个 ctx 桩：inject 声明后 ctx.tools 直接可用。 */
function makeCtx() {
  const registered: any[] = []
  const ctx = {
    tools: { register: (tool: any) => registered.push(tool) },
    on() {},
    effect() {},
  } as any
  return { ctx, registered }
}

test('plugin name is example-hello', () => {
  assert.equal(name, 'example-hello')
})

test('apply registers the greet tool', async () => {
  const { ctx, registered } = makeCtx()

  await apply(ctx, { greeting: 'Hello' })

  assert.equal(registered.length, 1)
  const tool = registered[0]
  assert.equal(tool.name, 'greet')
  assert.equal(tool.description, 'Greet someone by name.')
})

test('greet tool execute uses the configured greeting', async () => {
  const { ctx, registered } = makeCtx()

  await apply(ctx, { greeting: 'Hi' })
  const tool = registered[0]

  assert.equal(await tool.execute({ name: 'Ada' }), 'Hi, Ada!')
})
