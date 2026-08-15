#!/usr/bin/env node
/**
 * 上游文档同步脚本：跟踪 deepseek-ai/deepseek-harness（master）与插件开发相关的文档变更。
 *
 * 原理：
 *   1. 读取基线 scripts/upstream-baseline.json（上次同步时的上游 commit SHA + 每个关注文件的 sha256）；
 *   2. 通过 GitHub API 获取上游当前 master 的 commit 与文件树；
 *   3. 按关注清单（WATCH）筛选插件开发相关文件，逐一拉取 raw 内容并哈希比对；
 *   4. 报告 added / changed / removed 文件，并更新基线。
 *
 * 用法：
 *   node scripts/sync-upstream.mjs              同步：检测变更 + 更新基线（首次运行建立基线）
 *   node scripts/sync-upstream.mjs --check      只检查：有变更或基线缺失则退出码 1（CI / 定期巡检用）
 *
 * 检测到变更后，按 .agents/skills/sync-plugin-docs/SKILL.md 评估并移植到
 * docs/development/ 与 docs/spec/，再运行 `pnpm docs:sync`。
 *
 * 零依赖：仅使用 Node 内置模块（Node >= 18 自带 fetch）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const BASELINE_PATH = join(ROOT, 'scripts', 'upstream-baseline.json')
const CHECK_ONLY = process.argv.includes('--check')

const REPO = 'deepseek-ai/deepseek-harness'
const BRANCH = 'master'
const API = `https://api.github.com/repos/${REPO}`
const RAW = `https://raw.githubusercontent.com/${REPO}/${BRANCH}`

/**
 * 关注清单：与插件开发直接相关的上游文档/技能/架构笔记。
 * 以 '/' 结尾的是目录前缀；其余为精确文件路径。
 */
const WATCH = [
  'docs/user/develop/',                          // 官方插件开发教程（basic/framework/practice）
  'docs/cordis-primer.md',                       // Cordis 五要素
  'docs/cordis-tutorial/',                       // Cordis 上手教程
  'docs/cordis-api/',                            // Cordis API 参考（生成）
  'docs/cookbook/adding-a-tool.md',              // 工具创作参考
  'docs/cookbook/adding-a-package.md',           // 新增包参考
  'docs/cookbook/extension-cookbook.md',         // 扩展手册
  'docs/capability-seams.md',                    // 能力接缝
  'apps/cli/config/agent-presets/cordis/skills/', // 官方 Cordis 插件开发 SKILL
  '.agents/notes/implemented/architecture/2026-08-05-profile-plugin-bundles.md', // bundle/profile 机制
  '.agents/notes/implemented/architecture/2026-07-23-client-plugin-loading-model.md', // 客户端插件加载
  '.agents/notes/implemented/feature/2026-07-19-plugin-command-registration.md', // 命令注册
  '.agents/notes/implemented/feature/2026-08-10-web-plugin-configuration.md', // Web 插件配置
  '.agents/notes/implemented/architecture/2026-08-11-plugin-settings-tabs.md', // 插件设置页
  'packages/extensions/README.md',               // 扩展子系统生态
  'README.md',                                   // 仓库总览（版本/兼容信息）
]

function watchMatch(path) {
  return WATCH.some((w) => (w.endsWith('/') ? path.startsWith(w) : path === w))
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'dsh-plugins-sync-upstream' },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.json()
}

async function fetchText(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

const sha256 = (text) => createHash('sha256').update(text).digest('hex')

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
}

function main() {
  console.log(`🔍 检查上游 ${REPO}@${BRANCH} 插件开发文档变更……`)

  const baseline = loadBaseline()

  if (baseline) {
    // 快速路径：commit 未变 → 无变更
    fetchJson(`${API}/commits/${BRANCH}`)
      .then(async (commit) => {
        const head = commit.sha
        if (head === baseline.commit) {
          console.log(`✅ 上游无变更（仍为 ${head.slice(0, 12)}），共跟踪 ${Object.keys(baseline.files).length} 个文件`)
          return finish(null)
        }
        await diffAndSync(head, baseline)
      })
      .catch((err) => {
        console.error(`❌ 获取上游 commit 失败：${err.message}`)
        process.exit(1)
      })
  } else {
    // 首次运行：建立基线
    fetchJson(`${API}/commits/${BRANCH}`)
      .then(async (commit) => {
        const head = commit.sha
        const files = await collectWatched(head)
        const baselineData = { commit: head, syncedAt: new Date().toISOString(), files }
        mkdirSync(dirname(BASELINE_PATH), { recursive: true })
        writeFileSync(BASELINE_PATH, JSON.stringify(baselineData, null, 2) + '\n')
        console.log(`🆕 首次同步：已建立上游基线 commit ${head.slice(0, 12)}（跟踪 ${Object.keys(files).length} 个文件）`)
        console.log('   基线文件：scripts/upstream-baseline.json（应随仓库提交）')
        return finish(null)
      })
      .catch((err) => {
        console.error(`❌ 建立基线失败：${err.message}`)
        process.exit(1)
      })
  }

  /** 收集当前上游关注文件的 sha256 内容哈希。 */
  async function collectWatched(head) {
    const tree = await fetchJson(`${API}/git/trees/${head}?recursive=1`)
    const paths = tree.tree
      .filter((t) => t.type === 'blob' && watchMatch(t.path))
      .map((t) => t.path)
    const files = {}
    for (const p of paths) {
      const text = await fetchText(`${RAW}/${p.split('/').map(encodeURIComponent).join('/')}`)
      files[p] = sha256(text)
    }
    return files
  }

  /** 与基线比对，报告变更并按需更新基线。 */
  async function diffAndSync(head, base) {
    const files = await collectWatched(head)
    const changes = []

    for (const [path, hash] of Object.entries(files)) {
      if (!(path in base.files)) changes.push({ status: 'added', path })
      else if (base.files[path] !== hash) changes.push({ status: 'changed', path })
    }
    for (const path of Object.keys(base.files)) {
      if (!(path in files)) changes.push({ status: 'removed', path })
    }

    if (changes.length === 0) {
      console.log(`✅ 上游 commit 已更新（${base.commit.slice(0, 12)} → ${head.slice(0, 12)}），但关注文件内容无变化`)
      updateBaseline(head, files)
      return finish(null)
    }

    console.log(`\n⚠️  检测到 ${changes.length} 个插件开发相关文档变更（${base.commit.slice(0, 12)} → ${head.slice(0, 12)}）：\n`)
    for (const c of changes) {
      console.log(`  ${c.status === 'added' ? '🆕' : c.status === 'removed' ? '🗑️' : '✏️'} [${c.status}] ${c.path}`)
    }
    console.log(`\n   对比：https://github.com/${REPO}/compare/${base.commit}...${head}`)
    console.log('\n   下一步（按 .agents/skills/sync-plugin-docs/SKILL.md）：')
    console.log('     1. 逐一评估变更对插件开发契约/规范的影响')
    console.log('     2. 移植到 docs/development/ 与 docs/spec/（必要时更新 packages/example-hello）')
    console.log('     3. 运行 pnpm docs:sync 刷新插件清单')

    if (CHECK_ONLY) {
      console.error('\n❌ 上游有未同步的变更（docs:upstream:check 门禁失败）')
      process.exit(1)
    }
    updateBaseline(head, files)
    return finish(null)
  }

  function updateBaseline(head, files) {
    const data = { commit: head, syncedAt: new Date().toISOString(), files }
    mkdirSync(dirname(BASELINE_PATH), { recursive: true })
    writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2) + '\n')
    console.log(`\n✅ 基线已更新至 ${head.slice(0, 12)}`)
  }

  function finish(err) {
    if (err) {
      console.error(`❌ ${err.message}`)
      process.exit(1)
    }
    if (CHECK_ONLY) console.log('✅ 上游无未同步变更')
  }
}

main()
