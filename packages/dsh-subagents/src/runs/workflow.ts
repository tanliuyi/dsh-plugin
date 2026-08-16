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
  /** 结构化输出 JSON Schema（透传给 child 的 structuredOutputSchema）。 */
  outputSchema?: Record<string, unknown>
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
    status(keyOrRunId: string): RunsApiResult | undefined
    ref(result: RunsApiResult): string
    refs(results: RunsApiResult[]): string
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
export async function runWorkflowScript(options: WorkflowOptions): Promise<{ value: unknown; text: string; emitted: unknown[] }> {
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

/** 稳定 JSON 序列化（键排序），用于 workflow 同 key 指纹校验（对齐上游 stableRunJson）。 */
function stableRunJson(value: unknown): string {
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(v as Record<string, unknown>).sort()) out[key] = sort((v as Record<string, unknown>)[key])
      return out
    }
    return v
  }
  return JSON.stringify(sort(value))
}

  // 已启动的 run（key → 结果，per-execution），供 runs.status 查询
  const launched = new Map<string, RunsApiResult>()
  // 同 key 指纹（per-execution），供 runs.run/runs.all 的重复 key 校验
  const runFingerprints = new Map<string, string>()

  const runsApi = {
    // 对齐上游 scripted-workflow.ts 的 runs 校验：
    // - key 格式（1-128 字母数字 ._-，字母/数字开头）
    // - 禁止把编排参数（action/workflowScript/tasks/chain/parallel/concurrency/chainDir）当子代理参数
    // - 同 key 指纹校验：同一 key 用不兼容参数再次启动报错
    // - worktree 必须 boolean；gate 与 acceptance 互斥
    validateRunCall(key: string, item: unknown, label: string): WorkflowItem {
      if (typeof key !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(key)) {
        throw new Error(`${label} has an invalid key (1-128 chars, letters/digits/._-, starts with a letter or digit).`)
      }
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label} requires an item object.`)
      const params = item as Record<string, unknown>
      for (const forbidden of ['action', 'workflowScript', 'tasks', 'chain', 'parallel', 'concurrency', 'chainDir']) {
        if (Object.prototype.hasOwnProperty.call(params, forbidden)) {
          throw new Error(`${label} accepts one child via { agent, task } and execution controls only; remove '${forbidden}'.`)
        }
      }
      if (params.worktree !== undefined && typeof params.worktree !== 'boolean') throw new Error(`${label} worktree must be true or false.`)
      if (params.gate !== undefined && (typeof params.gate !== 'string' || !params.gate.trim())) throw new Error(`${label} gate must be a non-empty command string.`)
      if (params.gate !== undefined && params.acceptance !== undefined) throw new Error(`${label} gate cannot be combined with acceptance.`)
      const fingerprint = stableRunJson(params)
      const existing = runFingerprints.get(key)
      if (existing !== undefined && existing !== fingerprint) {
        throw new Error(`Duplicate workflow key '${key}' used with incompatible launch params.`)
      }
      runFingerprints.set(key, fingerprint)
      return item as WorkflowItem
    },
    async run(key: string, item: WorkflowItem): Promise<RunsApiResult> {
      this.validateRunCall(key, item, 'runs.run')
      if (item.worktree) throw new Error('worktree isolation is not supported by the dsh port; remove `worktree: true`')
      const result = await options.onSpawn(key, item)
      launched.set(key, result)
      return result
    },
    async all(items: Array<WorkflowItem & { key: string }>): Promise<RunsApiResult[]> {
      if (!Array.isArray(items)) throw new Error('runs.all(items) requires an array.')
      const calls: Array<{ key: string; item: WorkflowItem }> = []
      for (let index = 0; index < items.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(items, index)) throw new Error('runs.all items must not contain sparse entries.')
        const item = items[index]
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`runs.all item ${index} must be an object.`)
        const { key, ...rest } = item as WorkflowItem & { key: string }
        calls.push({ key, item: { ...rest, key } })
        this.validateRunCall(key, rest, `runs.all item ${index}`)
      }
      const results = await Promise.all(calls.map(({ key, item }) => options.onSpawn(key, item)))
      for (let index = 0; index < calls.length; index++) launched.set(calls[index]!.key, results[index]!)
      return results
    },
    status(keyOrRunId: string): RunsApiResult | undefined {
      if (launched.has(keyOrRunId)) return launched.get(keyOrRunId)
      for (const result of launched.values()) {
        if (result.runId === keyOrRunId) return result
      }
      return undefined
    },
    ref(result: RunsApiResult): string {
      if (!result || typeof result !== 'object') throw new Error('runs.ref(result) requires a run result object.')
      const parts = [`run ${result.key || 'unknown'}`]
      if (result.runId) parts.push(`id=${String(result.runId).slice(0, 8)}`)
      return `[${parts.join('; ')}]`
    },
    refs(results: RunsApiResult[]): string {
      if (!Array.isArray(results)) throw new Error('runs.refs(results) requires an array.')
      return results.map((result) => this.ref(result)).join('\n')
    },
  }

  // 受控定时器：脚本创建的 setTimeout 全部登记，结束/中止时统一清理
  const scriptTimers = new Set<ReturnType<typeof setTimeout>>()
  // emit 累计（对齐上游 scripted-workflow 的 emit(value)：可 JSON 序列化即可投递）
  const emitted: unknown[] = []
  const sandbox = {
    runs: runsApi,
    state: stateApi,
    prompts: promptsApi,
    Promise,
    JSON,
    Math,
    Date,
    console,
    emit: (value: unknown): void => {
      assertJsonValue(value, 'emit')
      emitted.push(value)
    },
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
  // 对齐上游：workflow 沙箱不提供动态代码生成（无 eval/Function 逃逸路径）
  const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } })
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
  // 对齐上游 assertJsonValue：返回值与 emit 值必须是可 JSON 序列化的
  assertJsonValue(value, 'workflow return')
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return { value, text, emitted }
}

/** 校验值可 JSON 序列化（对齐上游 scripted-workflow 的 assertJsonValue）。 */
function assertJsonValue(value: unknown, label: string): void {
  try {
    JSON.stringify(value)
  } catch (error) {
    throw new Error(`${label} must be JSON-serializable (got ${typeof value}: ${error instanceof Error ? error.message : String(error)})`)
  }
  if (value !== undefined && typeof value === 'object') {
    // 拒绝函数/符号/循环引用的显式检查（JSON.stringify 对函数返回 undefined 不报错）
    const seen = new Set<object>()
    const check = (node: unknown): void => {
      if (node === null || typeof node !== 'object') return
      if (typeof node === 'function' || typeof node === 'symbol' || typeof node === 'bigint') {
        throw new Error(`${label} must be JSON-serializable (found ${typeof node} in value)`)
      }
      if (seen.has(node)) throw new Error(`${label} must not contain circular references`)
      seen.add(node)
      if (Array.isArray(node)) {
        for (const item of node) check(item)
      } else {
        for (const key of Object.keys(node)) {
          if (typeof (node as Record<string, unknown>)[key] === 'function') {
            throw new Error(`${label} must be JSON-serializable (found function at '${key}')`)
          }
          check((node as Record<string, unknown>)[key])
        }
      }
    }
    check(value)
  }
}
