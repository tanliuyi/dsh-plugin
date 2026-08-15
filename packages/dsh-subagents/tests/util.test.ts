import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

import { resolveProjectRoot } from '../src/util.ts'

test('resolveProjectRoot: stops at the nearest .dsh/.git marker', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-util-root-'))
  const nested = path.join(root, 'a', 'b')
  mkdirSync(nested, { recursive: true })
  mkdirSync(path.join(root, '.git'))
  try {
    assert.equal(resolveProjectRoot(nested), root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveProjectRoot: home .dsh is not a project marker (project/user scope isolation)', () => {
  const home = mkdtempSync(path.join(os.tmpdir(), 'dsh-util-home-'))
  const work = mkdtempSync(path.join(os.tmpdir(), 'dsh-util-work-'))
  mkdirSync(path.join(home, '.dsh'))
  const previous = process.env.HOME
  try {
    process.env.HOME = home
    // 工作目录无标记：不得落回 home（旧行为导致 project 与 user 目录重合），应返回 cwd
    assert.equal(resolveProjectRoot(work), work)
    // 工作目录有 .git：正常解析为项目根
    mkdirSync(path.join(work, '.git'))
    assert.equal(resolveProjectRoot(work), work)
    // cwd 本身是 home：home 仍可作为项目根（用户在 home 下直接工作）
    assert.equal(resolveProjectRoot(home), home)
  } finally {
    if (previous === undefined) delete process.env.HOME
    else process.env.HOME = previous
    rmSync(home, { recursive: true, force: true })
    rmSync(work, { recursive: true, force: true })
  }
})
