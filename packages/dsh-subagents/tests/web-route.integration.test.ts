/**
 * Web 设置路由集成测试：真实 WebServer（随机端口）端到端验证 exact 路由
 * 注册、信任校验（真实 socket 对端 + Host + Origin + sec-fetch-site）与
 * GET/PUT/DELETE 全链路。补齐纯函数单测之外的传输层空白。
 */

import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { request } from 'node:http'
import * as os from 'node:os'
import * as path from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import { WebServer } from '@deepseek-ai/dsh-host-webserver'

import { Config } from '../src/config.ts'
import { normalizeConfig } from '../src/config.ts'
import { loadWebSettingsSync } from '../src/web-settings.ts'
import { registerWebSettingsRoute, WEB_SETTINGS_PATH } from '../src/web-route.ts'

let ctx: Context
let server: WebServer
let home: string
let baseUrl: string

/** 用 node:http 发请求（可自定义 Host 等 fetch 禁改头）。 */
function rawGet(hostHeader: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({
      host: '127.0.0.1',
      port: server.port,
      path: WEB_SETTINGS_PATH,
      headers: { host: hostHeader },
    }, (res) => {
      res.resume()
      resolve(res.statusCode ?? 0)
    })
    req.on('error', reject)
    req.end()
  })
}

before(async () => {
  home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-int-'))
  ctx = new Context()
  server = new WebServer(ctx, { host: '127.0.0.1', port: 0 })
  await server[Service.init]()
  registerWebSettingsRoute(ctx, server, {
    config: normalizeConfig(Config({})),
    baseline: normalizeConfig(Config({})),
    home,
  })
  baseUrl = `http://127.0.0.1:${server.port}`
})

after(async () => {
  // root Context 无 dispose；手动关闭 http server，避免残留 handle 挂住进程
  const httpServer = (server as unknown as { server: import('node:http').Server }).server
  httpServer.closeAllConnections()
  await new Promise<void>((resolve) => httpServer.close(() => resolve()))
  rmSync(home, { recursive: true, force: true })
})

test('集成: exact 路由已注册，信任校验端到端生效', async () => {
  // 回环 + 无 Origin → 200，响应含设置视图
  const ok = await fetch(baseUrl + WEB_SETTINGS_PATH)
  assert.equal(ok.status, 200)
  const body = await ok.json() as { baseline: Record<string, unknown>; effective: Record<string, unknown>; overrides: Record<string, unknown> }
  assert.ok('baseline' in body && 'effective' in body && 'overrides' in body)
  // cross-site → 403
  const cs = await fetch(baseUrl + WEB_SETTINGS_PATH, { headers: { 'sec-fetch-site': 'cross-site' } })
  assert.equal(cs.status, 403)
  // 跨源 Origin → 403
  const badOrigin = await fetch(baseUrl + WEB_SETTINGS_PATH, { headers: { origin: 'http://evil.example' } })
  assert.equal(badOrigin.status, 403)
  // 伪造 Host 头（真实 socket 对端仍为回环，Host 判据拒绝）→ 403
  assert.equal(await rawGet('evil.example:3080'), 403)
  // 非回环 Host → 403
  assert.equal(await rawGet('192.168.1.9:3080'), 403)
  // 未知路径 → 非 200（exact 未匹配）
  const miss = await fetch(baseUrl + '/api/subagents/nope')
  assert.notEqual(miss.status, 200)
})

test('集成: PUT 落盘 + live-apply，非法 400，DELETE 复位', async () => {
  // 写请求必须携带同源 Origin（CSRF 约束），fetch 默认不带，手动补
  const writeHeaders = { 'content-type': 'application/json', origin: baseUrl }
  const put = await fetch(baseUrl + WEB_SETTINGS_PATH, {
    method: 'PUT',
    headers: writeHeaders,
    body: JSON.stringify({ effective: { timeoutMs: 120000, missionsEnabled: false } }),
  })
  assert.equal(put.status, 200)
  const putBody = await put.json() as { applied: string[]; restartRequired: string[] }
  assert.deepEqual(putBody.applied, ['timeoutMs'])
  assert.deepEqual(putBody.restartRequired, ['missionsEnabled'])
  // 覆盖已落盘
  const saved = loadWebSettingsSync(home)
  assert.equal(saved.timeoutMs, 120000)
  assert.equal(saved.missionsEnabled, false)

  // 非法值 → 400 且不落盘
  const bad = await fetch(baseUrl + WEB_SETTINGS_PATH, {
    method: 'PUT',
    headers: writeHeaders,
    body: JSON.stringify({ effective: { timeoutMs: -1 } }),
  })
  assert.equal(bad.status, 400)
  assert.equal(loadWebSettingsSync(home).timeoutMs, 120000)

  // 无 Origin 的写请求 → 403（CSRF 关键约束端到端）
  const noOrigin = await fetch(baseUrl + WEB_SETTINGS_PATH, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ effective: { timeoutMs: 300000 } }),
  })
  assert.equal(noOrigin.status, 403)
  assert.equal(loadWebSettingsSync(home).timeoutMs, 120000)

  // DELETE 复位 → 覆盖清空
  const del = await fetch(baseUrl + WEB_SETTINGS_PATH, { method: 'DELETE', headers: { origin: baseUrl } })
  assert.equal(del.status, 200)
  assert.deepEqual(loadWebSettingsSync(home), {})
})
