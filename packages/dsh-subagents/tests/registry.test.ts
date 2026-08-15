import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { AgentRegistry, applyOverride, builtinAgentsDir } from '../src/agents/registry.ts'
import type { SubagentsConfig } from '../src/types.ts'

function baseConfig(overrides?: Record<string, unknown>): SubagentsConfig {
  return {
    toolDescriptionMode: 'compact',
    asyncByDefault: true,
    maxSubagentSpawnsPerRun: 64,
    maxSubagentDepth: 2,
    parallel: { maxTasks: 8, concurrency: 4 },
    missions: { enabled: true, retainTerminal: 200, globalIndex: true },
    scheduledRuns: { enabled: true, maxPending: 20 },
    intercomBridge: { mode: 'always', resultDelivery: false },
    watchdog: { enabled: false, main: {}, children: { overrides: {} }, scope: { enabled: false }, cadence: {}, autoFollow: { blockers: false, maxAttempts: 3, stalemateRepeats: 3 } },
    permissions: { rules: {} },
    artifactDir: 'temp',
    forceTopLevelAsync: false,
    waitTool: { enabled: true },
    ...overrides,
  } as SubagentsConfig
}

test('builtin discovery: all six builtin agents load from the package agents dir', async () => {
  const dir = builtinAgentsDir()
  assert.ok(dir.endsWith('agents'), `builtin dir should point at package agents/: ${dir}`)
  const registry = new AgentRegistry(baseConfig(), '/nonexistent-home')
  const agents = await registry.list('both')
  const names = agents.map((a) => a.name).sort()
  assert.deepEqual(names, ['delegate', 'oracle', 'researcher', 'reviewer', 'scout', 'worker'])
  const scout = agents.find((a) => a.name === 'scout')
  assert.ok(scout)
  assert.ok(scout.description.length > 0)
  assert.ok(scout.systemPrompt.includes('scout') || scout.systemPrompt.length > 50)
  assert.ok(scout.tools?.includes('read'))
  // dsh 工具名映射：find → glob
  assert.ok(!scout.tools?.includes('find'), 'tools should use dsh names (glob not find)')
})

test('oracle alias advisor resolves', async () => {
  const registry = new AgentRegistry(baseConfig(), '/nonexistent-home')
  const resolved = await registry.resolve('advisor')
  assert.equal(resolved.agent?.name, 'oracle')
  assert.equal(resolved.viaAlias, true)
})

test('resolve unknown agent errors', async () => {
  const registry = new AgentRegistry(baseConfig(), '/nonexistent-home')
  const resolved = await registry.resolve('no-such-agent')
  assert.ok(resolved.error)
})

test('user scope agents shadow builtins and project shadows user', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-home-'))
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-project-'))
  try {
    // 用户作用域自定义 scout
    const userDir = path.join(home, '.dsh', 'subagents', 'agents')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(path.join(userDir, 'scout.md'), '---\nname: scout\ndescription: user scout\n---\nUser body.')
    // 项目作用域自定义 scout
    const projectDir = path.join(projectRoot, '.dsh', 'subagents', 'agents')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(path.join(projectDir, 'scout.md'), '---\nname: scout\ndescription: project scout\n---\nProject body.')

    const registry = new AgentRegistry(baseConfig(), home)
    const user = await registry.resolve('scout', 'both', projectRoot)
    assert.equal(user.agent?.description, 'project scout')
    const projectOnly = await registry.resolve('scout', 'user', projectRoot)
    assert.equal(projectOnly.agent?.description, 'user scout')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('agentOverrides from config apply to builtins', async () => {
  const config = baseConfig({ agentOverrides: { reviewer: { description: 'Independent review tier', disabled: true } } })
  const registry = new AgentRegistry(config, '/nonexistent-home')
  const agents = await registry.list('both')
  assert.ok(!agents.some((a) => a.name === 'reviewer'), 'disabled override hides reviewer')
  const scout = agents.find((a) => a.name === 'scout')
  assert.ok(scout)
})

test('disableBuiltins hides all builtins', async () => {
  const registry = new AgentRegistry(baseConfig({ disableBuiltins: true }), '/nonexistent-home')
  const agents = await registry.list('both')
  assert.equal(agents.length, 0)
})

test('applyOverride merges fields', () => {
  const base = {
    name: 'x', localName: 'x', description: 'old', systemPrompt: 'body', scope: 'builtin' as const,
  }
  const merged = applyOverride(base as never, { description: 'new', model: 'deepseek-v4-pro' })
  assert.equal(merged.description, 'new')
  assert.equal(merged.model, 'deepseek-v4-pro')
  assert.equal(merged.systemPrompt, 'body')
})

test('permission frontmatter + tools allowlist parse', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-home2-'))
  try {
    const userDir = path.join(home, '.dsh', 'subagents', 'agents')
    mkdirSync(userDir, { recursive: true })
    writeFileSync(path.join(userDir, 'fanout.md'), '---\nname: fanout\ndescription: fanout agent\ntools: subagents, read\n---\nFan out.')
    const registry = new AgentRegistry(baseConfig(), home)
    const resolved = await registry.resolve('fanout')
    assert.deepEqual(resolved.agent?.tools, ['subagents', 'read'])
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test('invalidate: project cache refreshes after create (management write path)', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-home3-'))
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-project2-'))
  try {
    const registry = new AgentRegistry(baseConfig(), home)
    // 首次 project 扫描填充缓存（此时无自定义 agent）
    await registry.list('project', projectRoot)
    assert.ok((await registry.resolve('matrix-invalidated', 'project', projectRoot)).error, 'precondition: agent not visible')

    // 模拟 create：向 project 目录写入 agent 文件
    const projectDir = path.join(projectRoot, '.dsh', 'subagents', 'agents')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(path.join(projectDir, 'matrix-invalidated.md'), '---\nname: matrix-invalidated\ndescription: after create\n---\nBody.')

    // 未失效前：缓存仍旧，project 层看不到（复现 #3 的陈旧缓存）
    assert.ok((await registry.resolve('matrix-invalidated', 'project', projectRoot)).error, 'stale cache hides the new agent')

    // invalidate 后：立即可见
    registry.invalidate(projectRoot)
    const resolved = await registry.resolve('matrix-invalidated', 'project', projectRoot)
    assert.equal(resolved.agent?.description, 'after create')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})

test('resolve includeDisabled: enable can locate a disabled agent while list still hides it', async () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-home4-'))
  const projectRoot = mkdtempSync(path.join(os.tmpdir(), 'dsh-subagents-project3-'))
  try {
    const registry = new AgentRegistry(baseConfig(), home)
    const projectDir = path.join(projectRoot, '.dsh', 'subagents', 'agents')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(path.join(projectDir, 'matrix-disabled.md'), '---\nname: matrix-disabled\ndescription: probe\n---\nBody.')
    registry.invalidate(projectRoot)

    // 禁用（写 project overrides 模拟 disable 动作）
    const { setAgentDisabled, resolveManagementTarget } = await import('../src/agents/management.ts')
    await setAgentDisabled(resolveManagementTarget('project', projectRoot, home), 'matrix-disabled', true)
    registry.invalidate(projectRoot)

    // 默认 resolve/list：disabled agent 不可见
    assert.ok((await registry.resolve('matrix-disabled', 'project', projectRoot)).error, 'disabled agent must be hidden by default')
    const visible = await registry.list('project', projectRoot)
    assert.ok(!visible.some((agent) => agent.name === 'matrix-disabled'))

    // includeDisabled：enable 动作可定位到它及其作用域
    const resolved = await registry.resolve('matrix-disabled', 'project', projectRoot, true)
    assert.equal(resolved.agent?.name, 'matrix-disabled')
    assert.equal(resolved.agent?.scope, 'project')
  } finally {
    rmSync(home, { recursive: true, force: true })
    rmSync(projectRoot, { recursive: true, force: true })
  }
})
