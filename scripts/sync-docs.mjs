#!/usr/bin/env node
/**
 * 文档同步脚本：扫描 packages/ 下的插件包，重新生成 docs/plugins/INDEX.md，
 * 并执行规范符合性检查（spec/index.md 中列出的机器可检查项）。
 *
 * 用法：
 *   node scripts/sync-docs.mjs        重新生成 INDEX.md 并检查（有失败则退出码 1）
 *   node scripts/sync-docs.mjs --check  只检查（CI 门禁）：INDEX 漂移或有失败则退出码 1
 *
 * 零依赖：仅使用 Node 内置模块。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PACKAGES_DIR = join(ROOT, 'packages')
const INDEX_PATH = join(ROOT, 'docs', 'plugins', 'INDEX.md')
const CHECK_ONLY = process.argv.includes('--check')

const NAME_RE = /^@dsh-plugins\/[a-z0-9]+(-[a-z0-9]+)*$/
const SEMVER_RE =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/
const SPDX_RE = /^[A-Za-z0-9.+-]+(\s+(OR|AND|WITH)\s+[A-Za-z0-9.+-]+)*$/

/** @type {{ ok: boolean, name: string, detail: string }[]} */
const failures = []
/** @type {{ ok: boolean, name: string, detail: string }[]} */
const warnings = []

function check(ok, name, detail) {
  const entry = { ok, name, detail }
  ;(ok ? warnings : failures).push(entry)
  return entry
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch (err) {
    return null
  }
}

/** 检查一个插件包目录，返回一览表行与检查明细。 */
function scanPackage(dir) {
  const pkgDir = join(PACKAGES_DIR, dir)
  const shortName = basename(pkgDir)
  const manifestPath = join(pkgDir, 'package.json')
  const manifest = readJson(manifestPath)
  const details = []

  if (!manifest) {
    details.push(check(false, 'package.json', `缺少 ${manifestPath}`))
    return { shortName, row: null, details }
  }

  const name = manifest.name ?? ''
  const short = name.startsWith('@') ? name.split('/')[1] : null

  details.push(check(
    NAME_RE.test(name),
    'name',
    `包名 ${name || '(缺失)'} 必须匹配 @dsh-plugins/<kebab-case>`,
  ))
  details.push(check(
    short === shortName,
    '目录名',
    `目录名 ${shortName} 必须等于包短名 ${short}`,
  ))
  details.push(check(
    typeof manifest.version === 'string' && SEMVER_RE.test(manifest.version),
    'version',
    `version ${JSON.stringify(manifest.version)} 必须是合法 semver`,
  ))
  details.push(check(
    typeof manifest.description === 'string' && manifest.description.length > 0,
    'description',
    'description 必须是非空字符串（规范要求一句话说明）',
  ))
  details.push(check(
    manifest.type === 'module',
    'type',
    `type 必须是 "module"（当前 ${JSON.stringify(manifest.type)}）`,
  ))
  details.push(check(
    typeof manifest.license === 'string' && SPDX_RE.test(manifest.license),
    'license',
    `license 必须是合法 SPDX 表达式（当前 ${JSON.stringify(manifest.license)}）`,
  ))
  details.push(check(
    existsSync(join(pkgDir, 'README.md')),
    'README',
    '包必须提供 README.md（见 docs/spec/docs.md）',
  ))
  details.push(check(
    typeof manifest.scripts?.build === 'string',
    'scripts.build',
    '必须提供 build 脚本（产出 lib/）',
  ))
  details.push(check(
    typeof manifest.scripts?.test === 'string',
    'scripts.test',
    '必须提供 test 脚本（可为空用例但必须可运行）',
  ))

  const main = manifest.main
  if (main) {
    const exists = existsSync(join(pkgDir, main))
    details.push(check(
      exists,
      'main',
      exists ? `main 指向 ${main}（已构建）` : `main 指向的文件不存在：${main}（请先运行 pnpm build）`,
    ))
  } else {
    details.push(check(false, 'main', '必须声明 main 指向构建产物 lib/index.js'))
  }

  const bundle = manifest.dsh?.bundle
  const isBundle = Boolean(bundle)
  if (isBundle) {
    const patch = bundle.patch
    const patchExists = typeof patch === 'string' && existsSync(join(pkgDir, patch))
    details.push(check(
      patchExists,
      'dsh.bundle.patch',
      patchExists ? `patch ${patch} 存在` : `patch 文件不存在：${patch ?? '(未声明)'}`,
    ))
  }

  return {
    shortName,
    row: {
      name,
      version: manifest.version,
      kind: isBundle ? 'bundle' : 'library',
      description: manifest.description ?? '',
      ok: details.every((d) => d.ok),
    },
    details,
  }
}

/** 仓库级文档/结构检查。 */
function repoChecks() {
  const checks = []
  for (const rel of [
    'docs/README.md',
    'docs/development/index.md',
    'docs/spec/index.md',
    '.agents/skills/sync-plugin-docs/SKILL.md',
    'scripts/sync-docs.mjs',
    'scripts/sync-upstream.mjs',
    'scripts/upstream-baseline.json',
  ]) {
    checks.push(check(existsSync(join(ROOT, rel)), rel, `文件缺失：${rel}`))
  }
  return checks
}

function renderIndex(packages) {
  const okCount = packages.filter((p) => p.row?.ok).length
  const lines = []
  lines.push('# 插件清单（自动生成）')
  lines.push('')
  lines.push('> 本文件由 `scripts/sync-docs.mjs` 自动生成，**禁止手改**。重新生成：`pnpm docs:sync`。')
  lines.push('')
  lines.push('## 包一览')
  lines.push('')
  lines.push('| 包 | 版本 | 类型 | 描述 | 符合性 |')
  lines.push('| --- | --- | --- | --- | --- |')
  for (const p of packages) {
    if (!p.row) {
      lines.push(`| ${p.shortName}（缺少 package.json） | - | - | - | ❌ |`)
      continue
    }
    const { name, version, kind, description, ok } = p.row
    const desc = (description || '').replace(/\|/g, '\\|').slice(0, 80)
    lines.push(`| [${name}](${join('..', '..', 'packages', p.shortName)}) | ${version} | ${kind} | ${desc} | ${ok ? '✅' : '❌'} |`)
  }
  lines.push('')
  lines.push('## 检查报告')
  lines.push('')
  for (const p of packages) {
    lines.push(`### ${p.shortName}`)
    lines.push('')
    if (p.details.length === 0) {
      lines.push('- （无）')
    }
    for (const d of p.details) {
      lines.push(`- ${d.ok ? '✅' : '❌'} ${d.name}：${d.detail}`)
    }
    lines.push('')
  }
  const repo = repoChecks()
  lines.push('## 仓库结构与文档检查')
  lines.push('')
  for (const d of repo) {
    lines.push(`- ${d.ok ? '✅' : '❌'} ${d.name}：${d.detail}`)
  }
  lines.push('')
  const total = packages.reduce((n, p) => n + p.details.length, 0) + repo.length
  const bad = failures.length
  lines.push(`---`)
  lines.push('')
  lines.push(`共 ${packages.length} 个包，检查 ${total} 项，失败 ${bad} 项：${bad === 0 ? '✅ 全部通过' : '❌ 请修复后重跑'}`)
  lines.push('')
  return lines.join('\n')
}

function main() {
  if (!existsSync(PACKAGES_DIR)) {
    console.error(`❌ packages/ 目录不存在：${PACKAGES_DIR}`)
    process.exit(1)
  }

  const entries = readdirSync(PACKAGES_DIR)
    .filter((e) => statSync(join(PACKAGES_DIR, e)).isDirectory())
    .sort()

  const packages = entries.map(scanPackage)
  if (packages.length === 0) {
    console.warn('⚠️  packages/ 下没有插件包')
  }

  // 仓库级检查也要计入失败列表（供最终退出码使用）
  repoChecks()

  const content = renderIndex(packages)

  if (CHECK_ONLY) {
    const drift = !existsSync(INDEX_PATH) || readFileSync(INDEX_PATH, 'utf8') !== content
    if (drift) {
      failures.push({ ok: false, name: 'INDEX 漂移', detail: 'docs/plugins/INDEX.md 与 packages/ 不一致，请运行 pnpm docs:sync' })
      console.error('❌ docs/plugins/INDEX.md 已漂移（运行 `pnpm docs:sync` 重新生成）')
    } else {
      console.log('✅ docs/plugins/INDEX.md 无漂移')
    }
  } else {
    mkdirSync(dirname(INDEX_PATH), { recursive: true })
    writeFileSync(INDEX_PATH, content)
    console.log(`✅ 已重新生成 ${INDEX_PATH}`)
  }

  for (const f of failures) {
    console.error(`❌ ${f.name}：${f.detail}`)
  }
  if (failures.length === 0) {
    console.log('✅ 规范符合性检查全部通过')
  }

  process.exit(failures.length === 0 ? 0 : 1)
}

main()
