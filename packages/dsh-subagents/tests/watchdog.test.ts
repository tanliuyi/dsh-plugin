import assert from 'node:assert/strict'
import test from 'node:test'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { DEFAULT_WATCHDOG_CONFIG, resolveWatchdogConfig, writeUserWatchdogEnabled, writeWatchdogModelSettings, getWatchdogUserSettingsPath } from '../src/watchdog/settings.ts'
import { WatchdogEmissionGuard, watchdogWarningIdentity } from '../src/watchdog/emission-guard.ts'
import { WatchdogScopeArtifact } from '../src/watchdog/scope.ts'
import { WatchdogTurnAccumulator } from '../src/watchdog/turn-delta.ts'
import { parseWatchdogThinkingInput } from '../src/watchdog/model-selection.ts'
import { formatWatchdogWarningContent } from '../src/watchdog/warning-format.ts'

function tmpHome(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dshsub-wd-'))
}

test('DEFAULT_WATCHDOG_CONFIG: 与上游默认对齐（scope 开、autoFollow.blockers 开、LSP 开、agentEndTimeoutMs 30s）', () => {
  assert.equal(DEFAULT_WATCHDOG_CONFIG.enabled, false)
  assert.equal(DEFAULT_WATCHDOG_CONFIG.scope.enabled, true)
  assert.equal(DEFAULT_WATCHDOG_CONFIG.autoFollow.blockers, true)
  assert.equal(DEFAULT_WATCHDOG_CONFIG.autoFollow.maxAttempts, 3)
  assert.equal(DEFAULT_WATCHDOG_CONFIG.autoFollow.stalemateRepeats, 3)
  assert.equal(DEFAULT_WATCHDOG_CONFIG.agentEndTimeoutMs, 30_000)
  assert.equal(DEFAULT_WATCHDOG_CONFIG.lsp.enabled, true)
  assert.equal(DEFAULT_WATCHDOG_CONFIG.lsp.timeoutMs, 3_000)
  assert.equal(DEFAULT_WATCHDOG_CONFIG.cadence.everyNTools, null)
  assert.equal(DEFAULT_WATCHDOG_CONFIG.delivery, 'held')
  assert.equal(DEFAULT_WATCHDOG_CONFIG.lateWarningPolicy, 'show-stale-no-autofollow')
  assert.equal(DEFAULT_WATCHDOG_CONFIG.severityThreshold, 'concern')
  assert.equal(DEFAULT_WATCHDOG_CONFIG.children.enabled, false)
})

test('resolveWatchdogConfig: 配置面（config face）为基层，用户文件覆盖，会话覆盖最高', () => {
  const home = tmpHome()
  const configFace = { enabled: false, main: {}, children: { overrides: {} }, scope: { enabled: true }, cadence: {}, autoFollow: { blockers: true, maxAttempts: 3, stalemateRepeats: 3 } }
  const userFile = path.join(home, '.dsh', 'subagents', 'watchdog.json')
  fs.mkdirSync(path.dirname(userFile), { recursive: true })
  fs.writeFileSync(userFile, JSON.stringify({ enabled: true, main: { model: 'anthropic/claude-opus-4-8', thinking: 'high' } }))
  try {
    const r1 = resolveWatchdogConfig('/tmp', { config: configFace as never, home })
    assert.equal(r1.ok, true)
    assert.equal(r1.config.enabled, true)
    assert.equal(r1.config.main.enabled, true)
    assert.equal(r1.config.main.model, 'anthropic/claude-opus-4-8')
    assert.equal(r1.config.main.thinking, 'high')
    assert.equal(r1.config.scope.enabled, true) // 配置面默认（文件未覆盖）

    // 会话覆盖压过用户文件
    const r2 = resolveWatchdogConfig('/tmp', { config: configFace as never, home, session: { enabled: false } })
    assert.equal(r2.config.enabled, false)
    assert.equal(r2.config.main.enabled, false)

    const r3 = resolveWatchdogConfig('/tmp', { config: configFace as never, home, session: { main: { model: 'x/y' } } })
    assert.equal(r3.config.main.model, 'x/y')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('resolveWatchdogConfig: 非法文件报错进 errors，configOk=false 返回默认（对齐上游禁用语义）', () => {
  const home = tmpHome()
  const userFile = path.join(home, '.dsh', 'subagents', 'watchdog.json')
  fs.mkdirSync(path.dirname(userFile), { recursive: true })
  fs.writeFileSync(userFile, JSON.stringify({ enabled: 'not-a-boolean' }))
  try {
    const r = resolveWatchdogConfig('/tmp', { home })
    assert.equal(r.ok, false)
    assert.equal(r.errors.length, 1)
    assert.ok(r.errors[0]!.message.includes('enabled'))
    assert.equal(r.config.enabled, false) // 回退默认
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('writeUserWatchdogEnabled / writeWatchdogModelSettings: 扁平文件形状（enabled + main）', () => {
  const home = tmpHome()
  try {
    writeUserWatchdogEnabled(true, home)
    const file = JSON.parse(fs.readFileSync(getWatchdogUserSettingsPath(home), 'utf8'))
    assert.deepEqual(file, { enabled: true, main: { enabled: true } })

    writeWatchdogModelSettings({ scope: 'user', target: { kind: 'main' }, model: 'a/b', thinking: 'high' }, home)
    const file2 = JSON.parse(fs.readFileSync(getWatchdogUserSettingsPath(home), 'utf8'))
    assert.equal(file2.main.model, 'a/b')
    assert.equal(file2.main.thinking, 'high')

    writeWatchdogModelSettings({ scope: 'user', target: { kind: 'child', agent: 'worker' }, model: 'c/d' }, home)
    const file3 = JSON.parse(fs.readFileSync(getWatchdogUserSettingsPath(home), 'utf8'))
    assert.equal(file3.children.overrides.worker.model, 'c/d')
  } finally {
    fs.rmSync(home, { recursive: true, force: true })
  }
})

test('emission-guard: content-free 抑制、重复抑制、update-budget（一次评审 1 条）、maxWarnings', () => {
  const guard = new WatchdogEmissionGuard({ maxWarnings: 2 })
  const warning = (summary: string) => ({ severity: 'concern' as const, summary, evidence: 'e', recommendedAction: 'a', source: 'main' as const, category: 'other' as const, confidence: 'medium' as const })
  assert.equal(guard.evaluate(warning('looks good to me')).accepted, false) // content-free
  assert.equal(guard.evaluate(warning('real issue')).accepted, true)
  assert.equal(guard.evaluate(warning('real issue')).accepted, false) // duplicate
  assert.equal(guard.evaluate(warning('another issue')).accepted, false) // update-budget：同一评审只收 1 条
  guard.startModelUpdate() // 下一次评审
  assert.equal(guard.evaluate(warning('another issue')).accepted, true)
  assert.equal(guard.evaluate(warning('third issue')).accepted, false) // max-warnings
})

test('scope artifact: 有界条目 + render 语义', () => {
  const scope = new WatchdogScopeArtifact()
  for (let i = 0; i < 12; i++) scope.addPrompt(`prompt ${i}`)
  const rendered = scope.render()
  assert.ok(rendered.includes('Scope prompt 4')) // 只留最近 8 条
  assert.ok(!rendered.includes('prompt 0'))
  assert.ok(rendered.includes('supersede'))
  scope.reset()
  assert.equal(scope.render(), '')
})

test('turn-delta: user prompt + assistant 文本/思考 + 工具调用（edit 载荷 redact）+ 工具结果 diff', () => {
  const acc = new WatchdogTurnAccumulator()
  acc.addUserPrompt('fix the bug')
  acc.addAssistantMessage({
    content: [
      { type: 'text', text: 'Let me look.' },
      { type: 'reasoning', thinking: 'checking files' },
      { type: 'tool-call', id: 'c1', name: 'edit', arguments: JSON.stringify({ file: 'a.ts', oldText: 'x', newText: 'y' }) },
    ],
  })
  acc.registerToolCall('c1', 'edit')
  acc.addToolResult('c1', { content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'done' }] }] }, undefined, { diff: '--- a/a.ts\n+++ b/a.ts' })
  const delta = acc.render()
  assert.ok(delta.includes('User prompt:'))
  assert.ok(delta.includes('fix the bug'))
  assert.ok(delta.includes('Assistant:'))
  assert.ok(delta.includes('Let me look.'))
  assert.ok(delta.includes('Thinking:'))
  assert.ok(delta.includes('Tool call: edit'))
  assert.ok(delta.includes('[omitted')) // edit 载荷 redact
  assert.ok(!delta.includes('"newText"'))
  assert.ok(delta.includes('Tool result: edit'))
  assert.ok(delta.includes('Diff:'))
})

test('parseWatchdogThinkingInput: 合法级别 / false / inherit', () => {
  assert.equal(parseWatchdogThinkingInput('high'), 'high')
  assert.equal(parseWatchdogThinkingInput(false), false)
  assert.equal(parseWatchdogThinkingInput('false'), false)
  assert.equal(parseWatchdogThinkingInput(undefined), undefined)
  assert.throws(() => parseWatchdogThinkingInput('ultra'))
})

test('formatWatchdogWarningContent: XML 结构化警告文本', () => {
  const text = formatWatchdogWarningContent({
    severity: 'blocker',
    category: 'unsafe-change',
    confidence: 'high',
    source: 'main',
    summary: 'unsafe edit',
    evidence: 'ev',
    recommendedAction: 'fix',
  })
  assert.ok(text.includes('<subagent_watchdog'))
  assert.ok(text.includes('severity="blocker"'))
  assert.ok(text.includes('unsafe edit'))
  assert.ok(text.includes('blocker_guidance'))
})

test('watchdogWarningIdentity: 稳定身份（去重用）', () => {
  const a = { severity: 'concern' as const, summary: 'same', evidence: 'same' }
  const b = { severity: 'concern' as const, summary: 'same', evidence: 'same' }
  assert.equal(watchdogWarningIdentity(a), watchdogWarningIdentity(b))
})
