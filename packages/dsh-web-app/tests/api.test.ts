import test from 'node:test'
import assert from 'node:assert/strict'

import { respond, rpc } from '../web/src/dsh/api.ts'

test('rpc validates HTTP status, response envelope, and rpcId echo', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })

  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { rpcId: string }
    return Response.json({
      type: 'server-response',
      rpcId: request.rpcId,
      result: { ok: true, value: { accepted: true } },
    })
  }
  assert.deepEqual(await rpc('session.prompt', {}), { ok: true, value: { accepted: true } })

  globalThis.fetch = async () => Response.json({
    type: 'server-response',
    rpcId: 'wrong',
    result: { ok: true, value: null },
  })
  await assert.rejects(rpc('session.prompt', {}), /rpcId mismatch/)

  globalThis.fetch = async () => new Response('failure', { status: 500 })
  await assert.rejects(rpc('session.prompt', {}), /HTTP 500/)
})

test('ok:true accepts a JSON result that omits value (live unknown command admission miss)', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })

  // live host: 未知命令的 commands/execute 返回 result:{ok:true}，无 value。
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { rpcId: string }
    return Response.json({
      type: 'server-response',
      rpcId: request.rpcId,
      result: { ok: true },
    })
  }
  const result = await rpc<{ commandId: string } | undefined>('commands/execute', {})
  assert.deepEqual(result, { ok: true })
  // executeCommand 语义：省略的 value（undefined）是 admission miss，不当作已受理。
  assert.equal(result.ok && result.value === undefined, true)

  // ok:false 仍要求结构化 error。
  globalThis.fetch = async (_input, init) => {
    const request = JSON.parse(String(init?.body)) as { rpcId: string }
    return Response.json({
      type: 'server-response',
      rpcId: request.rpcId,
      result: { ok: false },
    })
  }
  await assert.rejects(rpc('commands/execute', {}), /invalid RPC result/)
})

test('respond rejects transport failures instead of clearing the pending interaction', async (t) => {
  const original = globalThis.fetch
  t.after(() => { globalThis.fetch = original })
  globalThis.fetch = async () => new Response('failure', { status: 503 })
  await assert.rejects(respond('request-1', { ok: true, value: {} }), /HTTP 503/)
})
