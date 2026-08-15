/**
 * 项目检测 — 根据当前工作目录判断是否处于项目中并解析项目名。
 * 移植自 pi-hermes-memory/src/project.ts（MIT）。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import * as os from 'node:os'
import { resolveProjectsRoot } from './paths.ts'

export interface ProjectInfo {
  /** 项目名（目录 basename），不在项目中时为 null */
  name: string | null
  /** 项目记忆目录路径，无项目时为 null */
  memoryDir: string | null
}

export interface ProjectSkillInfo extends ProjectInfo {
  /** 项目技能目录路径，无项目时为 null */
  skillsDir: string | null
}

/**
 * 解析 `dir` 所在仓库的共享仓库根。
 *
 * 镜像 `git rev-parse --git-common-dir`（不 spawn git）：linked worktree 的
 * `.git` 是指向 `<main>/.git/worktrees/<name>` 的文件，该目录里的 `commondir`
 * 指回共享的 `<main>/.git`。仓库外或无工作树根时返回 null。
 */
function findGitRepoRoot(dir: string): string | null {
  let current = path.resolve(dir)

  while (true) {
    const dotGit = path.join(current, '.git')
    let stat: fs.Stats | undefined
    try {
      stat = fs.statSync(dotGit)
    } catch {
      stat = undefined
    }

    if (stat?.isDirectory()) return current

    if (stat?.isFile()) {
      const commonDir = resolveWorktreeCommonDir(current, dotGit)
      if (!commonDir) return current
      return path.basename(commonDir) === '.git' ? path.dirname(commonDir) : commonDir
    }

    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

function resolveWorktreeCommonDir(worktreeRoot: string, dotGitFile: string): string | null {
  let pointer: string
  try {
    pointer = fs.readFileSync(dotGitFile, 'utf-8')
  } catch {
    return null
  }

  const match = /^gitdir:\s*(.+)$/m.exec(pointer)
  if (!match) return null

  const gitDir = path.resolve(worktreeRoot, match[1]!.trim())
  try {
    const commonDir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf-8').trim()
    if (commonDir) return path.resolve(gitDir, commonDir)
  } catch {
    // 不是 linked worktree，或旧布局没有 commondir。
  }

  // `<main>/.git/worktrees/<name>` — 上两级是共享 git 目录。
  const parent = path.dirname(gitDir)
  return path.basename(parent) === 'worktrees' ? path.dirname(parent) : null
}

const repoRootCache = new Map<string, string | null>()

/**
 * 从当前工作目录检测项目。
 *
 * "项目" 是任何不是用户主目录的目录。在 Git 仓库内，项目名取 *仓库根* 的
 * basename，这样所有 linked worktree 共享同一身份（#120）。Git 之外保持
 * 工作目录的 basename。
 *
 * 已存在的 `projects-memory/<cwd-basename>/` 目录优先于新推导的仓库名，
 * 升级不会孤立旧 cwd-basename 身份下写入的记忆。
 *
 * @param projectsMemoryDir - 项目记忆目录配置
 * @param cwd - 工作目录（缺省用 process.cwd()）
 */
export function detectProject(projectsMemoryDir = 'projects-memory', cwd?: string): ProjectInfo {
  const dir = cwd ?? process.cwd()
  const homeDir = os.homedir()

  const resolved = path.resolve(dir)
  const resolvedHome = path.resolve(homeDir)

  if (resolved === resolvedHome || resolved === '/' || !resolved || resolved === resolvedHome + '/') {
    return { name: null, memoryDir: null }
  }

  const cwdName = path.basename(resolved)
  if (!cwdName || cwdName === '.' || cwdName === '..') {
    return { name: null, memoryDir: null }
  }

  const projectsRoot = resolveProjectsRoot(projectsMemoryDir)
  const name = resolveProjectName(resolved, resolvedHome, cwdName, projectsRoot)

  return {
    name,
    memoryDir: path.join(projectsRoot, name),
  }
}

function resolveProjectName(
  resolved: string,
  resolvedHome: string,
  cwdName: string,
  projectsRoot: string,
): string {
  let repoRoot = repoRootCache.get(resolved)
  if (repoRoot === undefined) {
    repoRoot = findGitRepoRoot(resolved)
    repoRootCache.set(resolved, repoRoot)
  }

  if (!repoRoot || repoRoot === resolved || repoRoot === resolvedHome) return cwdName

  const repoName = path.basename(repoRoot)
  if (!repoName || repoName === cwdName) return cwdName

  // 迁移桥：旧 cwd-basename 身份下已有的存储继续生效，只有新目录采用仓库名。
  if (!fs.existsSync(path.join(projectsRoot, repoName)) && fs.existsSync(path.join(projectsRoot, cwdName))) {
    return cwdName
  }

  return repoName
}

/**
 * 检测项目及其技能目录。
 * @param projectsMemoryDir - 项目记忆目录配置
 * @param cwd - 工作目录
 */
export function detectProjectSkills(projectsMemoryDir = 'projects-memory', cwd?: string): ProjectSkillInfo {
  const project = detectProject(projectsMemoryDir, cwd)
  return {
    ...project,
    skillsDir: project.memoryDir ? path.join(project.memoryDir, 'skills') : null,
  }
}
