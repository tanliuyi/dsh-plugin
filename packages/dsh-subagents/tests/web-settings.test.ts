/**
 * Web 设置页宿主侧逻辑测试：覆盖文件读写、合并、live-apply、diff 与信任判据。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { Readable } from 'node:stream'
import * as os from 'node:os'
import * as path from 'node:path'
import type { IncomingMessage } from 'node:http'

import { Config } from '../src/config.ts'
import { normalizeConfig } from '../src/config.ts'
import {
  MAX_SETTING_KEYS,
  applyWebOverrides,
  applyWebValues,
  buildEffectiveConfig,
  classifyOverrides,
  computeOverrides,
  extractWebValues,
  loadWebSettings,
  loadWebSettingsSync,
  sanitizeWebValues,
  saveWebSettings,
  webSettingsFile,
} from '../src/web-settings.ts'
import { MAX_BODY_BYTES, handleSettingsApi, isTrustedRequest, readJsonBody } from '../src/web-route.ts'
import { readClientDeclaration } from '../src/web-client.ts'

const baseConfig = Config({})

function fakeReq(headers: Record<string, string | undefined>, remoteAddress = '127.0.0.1', method = 'GET'): IncomingMessage {
  return { headers, socket: { remoteAddress }, method } as unknown as IncomingMessage
}

test('sanitizeWebValues: 校验与规范扁平值', () => {
  const ok = sanitizeWebValues({
    asyncByDefault: true,
    timeoutMs: 3600000,
    defaultThinking: false,
    intercomMode: 'fork-only',
    watchdogMainModel: 'anthropic/claude-opus-4-8',
  })
  assert.equal(ok.ok, true)
  if (ok.ok) {
    assert.equal(ok.value.timeoutMs, 3600000)
    assert.equal(ok.value.defaultThinking, false)
  }

  const bad = sanitizeWebValues({ timeoutMs: -1, intercomMode: 'sometimes', nope: 1 })
  assert.equal(bad.ok, false)
  if (!bad.ok) {
    assert.ok(bad.errors.some((e) => e.includes('timeoutMs')))
    assert.ok(bad.errors.some((e) => e.includes('intercomMode')))
    assert.ok(bad.errors.some((e) => e.includes('未知')))
  }

  assert.equal(sanitizeWebValues(null).ok, false)
  assert.equal(sanitizeWebValues([]).ok, false)
  // 键数超限拒绝
  const tooMany: Record<string, unknown> = {}
  for (let i = 0; i < MAX_SETTING_KEYS + 1; i++) tooMany[`k${i}`] = 1
  assert.equal(sanitizeWebValues(tooMany).ok, false)
  // null/undefined 键被忽略
  const sparse = sanitizeWebValues({ timeoutMs: null, asyncByDefault: undefined, missionsEnabled: true })
  assert.equal(sparse.ok, true)
  if (sparse.ok) assert.deepEqual(sparse.value, { missionsEnabled: true })
})

test('readJsonBody: 坏 JSON 返回 undefined，超限返回 undefined', async () => {
  const fake = (text: string): IncomingMessage => Readable.from([Buffer.from(text)]) as unknown as IncomingMessage
  assert.deepEqual(await readJsonBody(fake('{ "a": 1 }')), { a: 1 })
  assert.equal(await readJsonBody(fake('{ not json')), undefined)
  assert.deepEqual(await readJsonBody(fake('')), {})
  // 超过 64KB → undefined（拒绝）
  assert.equal(await readJsonBody(fake('x'.repeat(MAX_BODY_BYTES + 1))), undefined)
  // 恰好等于上限（整体恰为 MAX_BODY_BYTES 字节，'{"pad":"' 8 字节 + '"}' 2 字节）仍可解析；
  // 判据是 `total > MAX_BODY_BYTES`（严格大于才拒绝）
  const atLimit = '{"pad":"' + 'y'.repeat(MAX_BODY_BYTES - 10) + '"}'
  assert.equal(Buffer.byteLength(atLimit), MAX_BODY_BYTES)
  assert.deepEqual(await readJsonBody(fake(atLimit)), { pad: 'y'.repeat(MAX_BODY_BYTES - 10) })
})

test('computeOverrides: 只保留与 baseline 不同的显式值', () => {
  const baseline = {
    asyncByDefault: true,
    timeoutMs: 3600000,
    defaultModel: 'a/b',
    missionsEnabled: true,
  }
  const effective = {
    asyncByDefault: false,
    timeoutMs: 3600000,
    defaultModel: 'a/b',
    missionsEnabled: true,
  }
  assert.deepEqual(computeOverrides(baseline, effective), { asyncByDefault: false })
  // undefined 的键不落盘
  assert.deepEqual(computeOverrides({ a: 1 }, { a: undefined }), {})
})

test('applyWebOverrides / applyWebValues: 就地修改归一化配置', () => {
  const config = normalizeConfig(Config({}))
  applyWebOverrides(config, {
    timeoutMs: 300000,
    missionsEnabled: false,
    watchdogMainModel: 'm/n',
    watchdogMainThinking: 'high',
  })
  assert.equal(config.timeoutMs, 300000)
  assert.equal(config.missions.enabled, false)
  assert.equal(config.watchdog.main.model, 'm/n')
  assert.equal(config.watchdog.main.thinking, 'high')

  // applyWebValues 是整体替换：未提供的键也写为 undefined（复位语义）
  applyWebValues(config, { timeoutMs: undefined })
  assert.equal(config.timeoutMs, undefined)
  assert.equal(config.asyncByDefault, undefined)

  // 覆盖合并（applyWebOverrides）只写提供的键，其余键不被触碰
  const config2 = normalizeConfig(Config({}))
  applyWebOverrides(config2, { timeoutMs: 300000 })
  assert.equal(config2.timeoutMs, 300000)
  assert.equal(config2.asyncByDefault, true)
})

test('buildEffectiveConfig: cordis 配置 + 覆盖 → 运行时配置', () => {
  const effective = buildEffectiveConfig(Config({}), { maxSubagentDepth: 4, watchdogEnabled: true })
  assert.equal(effective.maxSubagentDepth, 4)
  assert.equal(effective.watchdog.enabled, true)
  assert.equal(effective.missions.enabled, true) // 默认保留
})

test('classifyOverrides: live 键与重启键分流', () => {
  const { applied, restartRequired } = classifyOverrides({
    timeoutMs: 1,
    missionsEnabled: false,
    scheduledRunsEnabled: false,
    watchdogEnabled: true,
  })
  assert.deepEqual(applied.sort(), ['timeoutMs', 'watchdogEnabled'])
  assert.deepEqual(restartRequired.sort(), ['missionsEnabled', 'scheduledRunsEnabled'])
})

test('覆盖文件：同步/异步读写与损坏容错', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-web-'))
  try {
    // 文件不存在 → 空覆盖
    assert.deepEqual(loadWebSettingsSync(home), {})
    assert.deepEqual(await loadWebSettings(home), {})

    const overrides = { timeoutMs: 120000, intercomMode: 'off' as const }
    await saveWebSettings(home, overrides)
    assert.equal(webSettingsFile(home).endsWith(path.join('.dsh', 'subagents', 'web-settings.json')), true)
    assert.deepEqual(loadWebSettingsSync(home), overrides)
    assert.deepEqual(await loadWebSettings(home), overrides)

    // 损坏文件 → 空覆盖（不抛）
    const { writeFileSync } = await import('node:fs')
    writeFileSync(webSettingsFile(home), '{ not json', 'utf8')
    assert.deepEqual(loadWebSettingsSync(home), {})
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('isTrustedRequest: 回环 + 同源判定', () => {
  assert.equal(isTrustedRequest(fakeReq({ host: '127.0.0.1:3080' })), true)
  assert.equal(isTrustedRequest(fakeReq({ host: 'localhost:3080', origin: 'http://localhost:3080' })), true)
  // 跨源
  assert.equal(isTrustedRequest(fakeReq({ host: '127.0.0.1:3080', origin: 'http://evil.example' })), false)
  // cross-site fetch
  assert.equal(isTrustedRequest(fakeReq({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' })), false)
  // 非回环 Host
  assert.equal(isTrustedRequest(fakeReq({ host: '192.168.1.5:3080' })), false)
  // 无 Host
  assert.equal(isTrustedRequest(fakeReq({})), false)
  // 实际 TCP 对端非回环（伪造回环 Host 头也拒绝；IPv4-mapped IPv6 归一化）
  assert.equal(isTrustedRequest(fakeReq({ host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080' }, '192.168.1.9')), false)
  assert.equal(isTrustedRequest(fakeReq({ host: '127.0.0.1:3080' }, '::ffff:127.0.0.1')), true)
  assert.equal(isTrustedRequest(fakeReq({ host: '127.0.0.1:3080' }, '::1')), true)
  // 无 socket 信息（理论上不出现）一律拒绝
  assert.equal(isTrustedRequest({ headers: { host: '127.0.0.1:3080' } } as unknown as IncomingMessage), false)
})

test('isTrustedRequest: 写请求必须携带同源 Origin（CSRF 关键约束）', () => {
  const host = { host: '127.0.0.1:3080' }
  // GET 无 Origin：允许（只读 + 对端/Host 回环 + sec-fetch-site 判据）
  assert.equal(isTrustedRequest(fakeReq(host)), true)
  // 写请求无 Origin：一律拒绝（不依赖 sec-fetch-site 是否发送）
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    assert.equal(isTrustedRequest(fakeReq(host, '127.0.0.1', method)), false, `${method} 无 Origin 必须拒绝`)
    assert.equal(isTrustedRequest(fakeReq({ ...host, origin: 'http://127.0.0.1:3080' }, '127.0.0.1', method)), true, `${method} 同源 Origin 放行`)
    assert.equal(isTrustedRequest(fakeReq({ ...host, origin: 'http://evil.example' }, '127.0.0.1', method)), false, `${method} 跨源 Origin 拒绝`)
  }
  // OPTIONS（CORS 预检）按读处理，无 Origin 允许（最终 405）
  assert.equal(isTrustedRequest(fakeReq(host, '127.0.0.1', 'OPTIONS')), true)
})

test('extractWebValues: 与归一化配置互转', () => {
  const config = normalizeConfig(Config({}))
  const values = extractWebValues(config)
  assert.equal(values.asyncByDefault, true)
  assert.equal(values.missionsEnabled, true)
  assert.equal(values.watchdogEnabled, false)
  const roundtrip = normalizeConfig(Config({}))
  applyWebValues(roundtrip, values)
  // 只比较设置页可见面（watchdog.main 等未编辑字段的 undefined 键不计）
  assert.deepEqual(extractWebValues(roundtrip), values)
})

test('handleSettingsApi: GET 返回 baseline/effective/overrides', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-api-'))
  try {
    const baseline = normalizeConfig(Config({}))
    const config = normalizeConfig(Config({}))
    const result = await handleSettingsApi('GET', {}, { config, baseline, home })
    assert.equal(result.status, 200)
    const body = result.body as { baseline: Record<string, unknown>; effective: Record<string, unknown>; overrides: Record<string, unknown>; restartKeys: string[] }
    assert.deepEqual(body.baseline, body.effective)
    assert.deepEqual(body.overrides, {})
    assert.ok(body.restartKeys.includes('missionsEnabled'))
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('handleSettingsApi: PUT 计算覆盖、落盘并 live-apply', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-api-'))
  try {
    const baseline = normalizeConfig(Config({}))
    const config = normalizeConfig(Config({}))
    const result = await handleSettingsApi('PUT', {
      effective: { timeoutMs: 600000, missionsEnabled: false },
    }, { config, baseline, home })
    assert.equal(result.status, 200)
    const body = result.body as { applied: string[]; restartRequired: string[]; overrides: Record<string, unknown>; effective: Record<string, unknown> }
    assert.deepEqual(body.applied, ['timeoutMs'])
    assert.deepEqual(body.restartRequired, ['missionsEnabled'])
    // live-apply 已写进内存配置
    assert.equal(config.timeoutMs, 600000)
    assert.equal(config.missions.enabled, false)
    // baseline 不变
    assert.equal(baseline.timeoutMs, undefined)
    // 落盘
    assert.deepEqual(loadWebSettingsSync(home), { timeoutMs: 600000, missionsEnabled: false })
    // GET 回读一致
    const read = await handleSettingsApi('GET', {}, { config, baseline, home })
    assert.deepEqual((read.body as { effective: Record<string, unknown> }).effective.timeoutMs, 600000)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('handleSettingsApi: PUT 非法值 400 且不落盘', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-api-'))
  try {
    const baseline = normalizeConfig(Config({}))
    const config = normalizeConfig(Config({}))
    const result = await handleSettingsApi('PUT', { effective: { timeoutMs: -5, bogus: 1 } }, { config, baseline, home })
    assert.equal(result.status, 400)
    assert.ok((result.body.issues as string[]).some((i) => i.includes('timeoutMs')))
    assert.ok((result.body.issues as string[]).some((i) => i.includes('未知')))
    assert.equal(config.timeoutMs, undefined) // 未应用
    assert.deepEqual(loadWebSettingsSync(home), {}) // 未落盘
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('handleSettingsApi: DELETE 清空覆盖并复位到 baseline', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-api-'))
  try {
    const baseline = normalizeConfig(Config({}))
    const config = normalizeConfig(Config({}))
    await handleSettingsApi('PUT', { effective: { timeoutMs: 600000, watchdogEnabled: true } }, { config, baseline, home })
    assert.equal(config.timeoutMs, 600000)
    const result = await handleSettingsApi('DELETE', {}, { config, baseline, home })
    assert.equal(result.status, 200)
    assert.equal(config.timeoutMs, undefined) // 复位
    assert.equal(config.watchdog.enabled, false)
    assert.deepEqual(loadWebSettingsSync(home), {})
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('readClientDeclaration: 相对路径从 src/ 与 lib/ 都指向包根', () => {
  const declaration = readClientDeclaration()
  assert.ok(declaration, '应能读到 dsh.client 声明')
  // '../' 从 src/（tsx 测试）与 lib/（编译产物）都指向包根；bundle 必须真实存在
  assert.ok(declaration.clientPath.endsWith('dsh-subagents/lib/client.js'))
  assert.equal(existsSync(declaration.clientPath), true)
  assert.equal(declaration.immediately, true)
  assert.deepEqual(declaration.inject, ['@deepseek-ai/dsh-client-runtime', '@deepseek-ai/dsh-client-ui-settings'])
})

test('handleSettingsApi: PUT 未提供的键回落到 baseline 默认（不写 undefined）', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-api-'))
  try {
    const baseline = normalizeConfig(Config({}))
    const config = normalizeConfig(Config({}))
    // 表单只改了 timeoutMs，asyncByDefault 保持「继承默认」
    const result = await handleSettingsApi('PUT', { effective: { timeoutMs: 600000 } }, { config, baseline, home })
    assert.equal(result.status, 200)
    assert.equal(config.timeoutMs, 600000)
    // 未提供的键回落 baseline 默认（true），而不是被整体替换写为 undefined
    assert.equal(config.asyncByDefault, true)
    const body = result.body as { effective: Record<string, unknown> }
    assert.equal(body.effective.asyncByDefault, true)
    // 只落差异键
    assert.deepEqual(loadWebSettingsSync(home), { timeoutMs: 600000 })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('handleSettingsApi: 其他方法 405', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-api-'))
  try {
    const baseline = normalizeConfig(Config({}))
    const config = normalizeConfig(Config({}))
    const result = await handleSettingsApi('PATCH', {}, { config, baseline, home })
    assert.equal(result.status, 405)
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})
