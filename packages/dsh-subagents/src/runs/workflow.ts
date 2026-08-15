/**
 * workflowScript 执行器：在 node:vm 沙箱中运行脚本，暴露
 * `runs.run(key, opts)` / `runs.all(items)` / `state.get|set` / `prompts.render`。
 * 沙箱无文件系统与网络能力（对应 pi-subagents 的 workflow 沙箱）。
 */

import vm from 'node:vm'
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import type { AgentConfig, RunRecord, SubagentsParams } from '../types.ts'
import type { SpawnDeps } from './spawn.ts'
import { spawnChild } from './spawn.ts'
import { MISSION_STATE_LIMIT_BYTES, MAX_WORKFLOW_SYNC_TIMEOUT_MS } from '../types.ts'
import { readJsonFile, writeJsonAtomic } from '../util.ts'
import { parseFrontmatter } from '../agents/frontmatter.ts'

/** workflow 一步（runs.run / runs.all 的条目）。 */
export interface WorkflowItem {
  key?: string
  agent: string
  task: string
  context?: 'fresh' | 'fork'
  model?: string
  worktree?: boolean
  gate?: string
  acceptance?: unknown
  output?: string | false
}

/** runs.run / runs.all 的返回值。 */
export interface RunsApiResult {
  key: string
  agent: string
  runId?: string
  output: string
  status: string
  artifactPaths: Record<string, string>
}

/** 沙箱 state 接口（经 enclosing mission 持久化）。 */
export interface WorkflowStateApi {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

/** 沙箱 prompts 接口（渲染包内/用户/项目提示词模板）。 */
export interface PromptsApi {
  render(ref: string, vars?: Record<string, string | number | boolean>): Promise<string>
}

/** 沙箱暴露的运行时 API。 */
export interface WorkflowRuntime {
  runs: {
    run(key: string, item: WorkflowItem): Promise<RunsApiResult>
    all(items: Array<WorkflowItem & { key: string }>): Promise<RunsApiResult[]>
  }
  state: WorkflowStateApi
  prompts: PromptsApi
}

/** runWorkflowScript 的输入。 */
export interface WorkflowOptions {
  script: string
  run: RunRecord
  params: SubagentsParams
  missionStateFile?: string
  promptDirs: { package: string; user: string; project: string }
  onSpawn: (key: string, item: WorkflowItem) => Promise<RunsApiResult>
  /** 上游取消信号（父工具 abort / 运行超时），中止脚本执行并清理沙箱定时器。 */
  signal?: AbortSignal
}

/** 从脚本提取 runs.run/runs.all 的 lane keys（移植自 pi-subagents）。 */
export function workflowLaneKeys(script: string): string[] {
  const keys: string[] = []
  const seen = new Set<string>()
  const add = (key: string): void => {
    if (!seen.has(key)) {
      seen.add(key)
      keys.push(key)
    }
  }
  const isIdentifier = (char: string | undefined): boolean => char !== undefined && /[\w$]/.test(char)
  const skipTrivia = (start: number): number => {
    let index = start
    while (index < script.length) {
      if (/\s/.test(script[index]!)) index += 1
      else if (script.startsWith('//', index)) {
        const end = script.indexOf('\n', index + 2)
        index = end === -1 ? script.length : end + 1
      } else if (script.startsWith('/*', index)) {
        const end = script.indexOf('*/', index + 2)
        index = end === -1 ? script.length : end + 2
      } else break
    }
    return index
  }
  const readLiteral = (start: number): { key?: string; end: number } | undefined => {
    const quote = script[start]
    if (quote !== "'" && quote !== '"' && quote !== '`') return undefined
    let index = start + 1
    let dynamicTemplate = false
    while (index < script.length) {
      if (script[index] === '\\') {
        index += 2
        continue
      }
      if (quote === '`' && script.startsWith('${', index)) dynamicTemplate = true
      if (script[index] === quote) return { key: dynamicTemplate ? undefined : script.slice(start + 1, index), end: index + 1 }
      if (quote !== '`' && /[\r\n]/.test(script[index]!)) return { end: index + 1 }
      index += 1
    }
    return { end: script.length }
  }

  const collectRunsAllKeys = (start: number): number => {
    let index = skipTrivia(start)
    if (script[index] !== '(') return start
    index = skipTrivia(index + 1)
    if (script[index] !== '[') return start
    let arrayDepth = 1
    let objectDepth = 0
    let directChildObject = false
    let expectingElement = true
    for (index += 1; index < script.length; index += 1) {
      index = skipTrivia(index)
      const literal = readLiteral(index)
      if (literal) {
        index = literal.end - 1
        continue
      }
      if (script[index] === '[') {
        arrayDepth += 1
        expectingElement = false
        continue
      }
      if (script[index] === ']') {
        arrayDepth -= 1
        if (arrayDepth === 0) return index + 1
        continue
      }
      if (script[index] === '{') {
        objectDepth += 1
        if (objectDepth === 1) directChildObject = arrayDepth === 1 && expectingElement
        expectingElement = false
        continue
      }
      if (script[index] === '}') {
        objectDepth -= 1
        if (objectDepth === 0) directChildObject = false
        continue
      }
      if (script[index] === ',' && arrayDepth === 1 && objectDepth === 0) {
        expectingElement = true
        continue
      }
      if (directChildObject && objectDepth === 1 && !isIdentifier(script[index - 1]) && script.startsWith('key', index) && !isIdentifier(script[index + 3])) {
        const colon = skipTrivia(index + 3)
        const key = script[colon] === ':' ? readLiteral(skipTrivia(colon + 1)) : undefined
        if (key) {
          const next = skipTrivia(key.end)
          if (key.key !== undefined && (script[next] === ',' || script[next] === '}')) add(key.key)
          index = key.end - 1
        }
      }
    }
    return index
  }

  for (let index = 0; index < script.length;) {
    index = skipTrivia(index)
    const literal = readLiteral(index)
    if (literal) {
      index = literal.end
      continue
    }
    if (!isIdentifier(script[index - 1]) && script.startsWith('runs.run', index) && !isIdentifier(script[index + 8])) {
      const open = skipTrivia(index + 8)
      const key = script[open] === '(' ? readLiteral(skipTrivia(open + 1)) : undefined
      if (key) {
        const next = skipTrivia(key.end)
        if (key.key !== undefined && (script[next] === ',' || script[next] === ')')) add(key.key)
        index = key.end
        continue
      }
    }
    if (!isIdentifier(script[index - 1]) && script.startsWith('runs.all', index) && !isIdentifier(script[index + 8])) {
      index = collectRunsAllKeys(index + 8)
      continue
    }
    index += 1
  }
  return keys
}

/** 渲染 `{{name}}` 占位符。 */
export function renderTemplate(template: string, vars?: Record<string, string | number | boolean>): string {
  if (!vars) return template
  let out = template
  for (const [key, value] of Object.entries(vars)) {
    out = out.replaceAll(`{{${key}}}`, String(value))
  }
  return out
}

/** 加载 prompt 模板（去 frontmatter）。 */
export async function loadPromptTemplate(ref: string, dirs: WorkflowOptions['promptDirs']): Promise<string | undefined> {
  const [scope, name] = ref.split(':')
  if (!scope || !name) return undefined
  const base = scope === 'package' ? dirs.package : scope === 'user' ? dirs.user : scope === 'project' ? dirs.project : undefined
  if (!base) return undefined
  const filePath = path.join(base, `${name}.md`)
  let content: string
  try {
    content = await readFile(filePath, 'utf8')
  } catch {
    return undefined
  }
  return parseFrontmatter(content).body
}

/**
 * 在 vm 沙箱中执行 workflowScript，返回脚本的 JSON 化结果。
 * 沙箱定时器受控：脚本创建的 timer 全部登记，结束（含中止/异常）时统一清理；
 * 异步等待有真实上限（signal 中止），同步死循环由 vm timeout 兜底。
 */
export async function runWorkflowScript(options: WorkflowOptions): Promise<{ value: unknown; text: string }> {
  const { script } = options

  const stateApi: WorkflowStateApi = {
    async get(key: string): Promise<unknown> {
      if (!options.missionStateFile) return undefined
      const state = await readJsonFile<Record<string, unknown>>(options.missionStateFile)
      return state?.[key]
    },
    async set(key: string, value: unknown): Promise<void> {
      if (!options.missionStateFile) return
      const state = (await readJsonFile<Record<string, unknown>>(options.missionStateFile)) ?? {}
      state[key] = value
      const bytes = Buffer.byteLength(JSON.stringify(state))
      if (bytes > MISSION_STATE_LIMIT_BYTES) throw new Error(`mission state exceeds the 256 KiB limit (${bytes} bytes)`)
      await writeJsonAtomic(options.missionStateFile, state)
    },
  }

  const promptsApi: PromptsApi = {
    async render(ref: string, vars?: Record<string, string | number | boolean>): Promise<string> {
      const template = await loadPromptTemplate(ref, options.promptDirs)
      if (template === undefined) throw new Error(`prompt template not found: ${ref}`)
      return renderTemplate(template, vars)
    },
  }

  const runsApi = {
    async run(key: string, item: WorkflowItem): Promise<RunsApiResult> {
      if (item.worktree) throw new Error('worktree isolation is not supported by the dsh port; remove `worktree: true`')
      return options.onSpawn(key, item)
    },
    async all(items: Array<WorkflowItem & { key: string }>): Promise<RunsApiResult[]> {
      const results = await Promise.all(items.map((item) => options.onSpawn(item.key, item)))
      return results
    },
  }

  // 受控定时器：脚本创建的 setTimeout 全部登记，结束/中止时统一清理
  const scriptTimers = new Set<ReturnType<typeof setTimeout>>()
  const sandbox = {
    runs: runsApi,
    state: stateApi,
    prompts: promptsApi,
    Promise,
    JSON,
    Math,
    Date,
    console,
    setTimeout: (callback: () => void, delay?: number): ReturnType<typeof setTimeout> => {
      const id = setTimeout(callback, Math.max(0, delay ?? 0))
      scriptTimers.add(id)
      return id
    },
    clearTimeout: (id: ReturnType<typeof setTimeout>): void => {
      scriptTimers.delete(id)
      clearTimeout(id)
    },
  }
  const context = vm.createContext(sandbox)
  const wrapped = `(async () => {\n${script}\n})()`
  const program = new vm.Script(wrapped, { filename: 'workflowScript' })

  // 真实中止：vm timeout 只约束同步段，异步挂起由 signal 竞速终止
  let rejectAbort: ((reason: Error) => void) | undefined
  const abortPromise = new Promise<never>((_resolve, reject) => {
    rejectAbort = reject
  })
  const onAbort = (): void => {
    rejectAbort?.(new Error('workflow script aborted'))
  }
  if (options.signal?.aborted) onAbort()
  else options.signal?.addEventListener('abort', onAbort, { once: true })

  let value: unknown
  try {
    const runPromise = Promise.resolve().then(() => program.runInContext(context, { timeout: MAX_WORKFLOW_SYNC_TIMEOUT_MS }))
    value = await Promise.race([runPromise, abortPromise])
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    for (const id of scriptTimers) clearTimeout(id)
    scriptTimers.clear()
  }
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return { value, text }
}
