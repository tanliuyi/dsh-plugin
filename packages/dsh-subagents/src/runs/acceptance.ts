/**
 * 验收门：级别推断（auto/none/attested/checked/verified）、结构化
 * acceptance-report 解析、evidence 状态与 `gate` 一键验证命令。
 */

import { execFile } from 'node:child_process'
import type { AcceptanceSpec, AgentConfig, SubagentsParams } from '../types.ts'
import { DEFAULT_GATE_TIMEOUT_MS } from '../types.ts'

/** evidence 汇总状态。 */
export type EvidenceStatus =
  | 'claimed' | 'attested' | 'checked' | 'verified' | 'review-required' | 'reviewed' | 'rejected'

/** 解析后的验收策略。 */
export interface ResolvedAcceptance {
  level: 'none' | 'attested' | 'checked' | 'verified'
  criteria: string[]
  evidence: string[]
  verify: Array<{ id?: string; command: string; timeoutMs?: number }>
  review?: { required?: boolean; agent?: string }
}

const WRITER_HINTS = /implement|fix|write|edit|refactor|build|add .*feature|create|update|apply|change|migrate|upgrade|debug|repair/
const READONLY_HINTS = /review|inspect|read|analyze|summarize|scout|research|lookup|check|validate|audit/

/** 推断验收级别与 review 需求（对应 pi 的 acceptance inference）。 */
export function inferAcceptance(
  params: SubagentsParams,
  agent: AgentConfig,
  isAsync: boolean,
): { spec: ResolvedAcceptance; inferred: boolean } {
  const task = params.task ?? ''
  const lower = task.toLowerCase()
  const explicit = params.acceptance
  const agentLevel = agent.acceptance?.level
  const role = agent.acceptanceRole

  // 显式字符串级别
  if (typeof explicit === 'string' && explicit !== 'auto' && explicit !== 'false') {
    return { spec: normalizeLevel(explicit as AcceptanceSpec['level'], agent, params, isAsync), inferred: false }
  }
  if (typeof explicit === 'object' && explicit !== null && !Array.isArray(explicit)) {
    return { spec: normalizeSpec(explicit as AcceptanceSpec, agent, params, isAsync), inferred: false }
  }
  if (explicit === false) {
    return { spec: { level: 'none', criteria: [], evidence: [], verify: [] }, inferred: false }
  }

  // 自动推断
  if (agentLevel && agentLevel !== 'auto') {
    return { spec: normalizeLevel(agentLevel, agent, params, isAsync), inferred: true }
  }

  const mutation = WRITER_HINTS.test(lower)
  const readonly = READONLY_HINTS.test(lower) && !mutation
  const isWriter = role === 'writer' || (mutation && role !== 'read-only') || (!readonly && !role && /worker|implementer|developer|coder/.test(agent.name))
  const isReadOnly = role === 'read-only' || (readonly && role !== 'writer')

  if (isReadOnly) {
    return { spec: { level: 'attested', criteria: [], evidence: [], verify: [] }, inferred: true }
  }
  if (isWriter) {
    const risky = isAsync || /risky|production|migration|breaking|security/i.test(lower)
    if (risky) {
      return {
        spec: { level: 'checked', criteria: [], evidence: ['changed-files', 'tests-added', 'commands-run', 'residual-risks', 'no-staged-files'], verify: [], review: { required: true, agent: 'reviewer' } },
        inferred: true,
      }
    }
    return {
      spec: { level: 'checked', criteria: [], evidence: ['changed-files', 'tests-added', 'commands-run', 'residual-risks'], verify: [] },
      inferred: true,
    }
  }
  return { spec: { level: 'attested', criteria: [], evidence: [], verify: [] }, inferred: true }
}

function normalizeLevel(level: AcceptanceSpec['level'] | undefined, agent: AgentConfig, params: SubagentsParams, isAsync: boolean): ResolvedAcceptance {
  const base = inferAcceptance({ ...params, acceptance: undefined }, agent, isAsync).spec
  switch (level) {
    case 'none': throw new Error('acceptance level "none" requires a reason: use { level: "none", reason: "..." }')
    case 'attested': return { level: 'attested', criteria: [], evidence: [], verify: [] }
    case 'verified': return { ...base, level: 'verified', review: undefined }
    default: return { ...base, level: 'checked' }
  }
}

function normalizeSpec(spec: AcceptanceSpec, agent: AgentConfig, params: SubagentsParams, isAsync: boolean): ResolvedAcceptance {
  if (spec.level === undefined || spec.level === 'auto') {
    return inferAcceptance({ ...params, acceptance: undefined }, agent, isAsync).spec
  }
  if (spec.level === 'none' && !spec.reason) {
    // 裸 "none" 被拒绝：必须带 reason（与 pi 一致）
    throw new Error('acceptance level "none" requires a reason: use { level: "none", reason: "..." }')
  }
  if ((spec.level as string) === 'reviewed') {
    throw new Error('"reviewed" is not a policy level; use { level: "checked", review: { required: true, agent: "reviewer" } } and orchestrate the reviewer separately')
  }
  return {
    level: spec.level === 'none' ? 'none' : spec.level,
    criteria: spec.criteria ?? [],
    evidence: spec.evidence ?? [],
    verify: spec.verify ?? [],
    review: spec.review,
  }
}

/** 把 `gate` 简写规范为 verified + 单命令。 */
export function gateToAcceptance(gate: string): ResolvedAcceptance {
  return {
    level: 'verified',
    criteria: [],
    evidence: ['changed-files', 'tests-added', 'commands-run', 'residual-risks', 'no-staged-files'],
    verify: [{ id: 'gate', command: gate, timeoutMs: DEFAULT_GATE_TIMEOUT_MS }],
  }
}

/** 子代理 acceptance-report 的解析结果。 */
export interface ParsedReport {
  changedFiles?: string[]
  testsAddedOrUpdated?: string[]
  commandsRun?: Array<{ command: string; exitCode?: number }>
  validation?: Array<{ name: string; status?: string; detail?: string }>
  residualRisks?: string[]
  noStagedFiles?: boolean
}

/** 解析子代理输出中的 fenced `acceptance-report` JSON。 */
export function parseAcceptanceReport(output: string): ParsedReport | undefined {
  const fence = /```(?:acceptance-report|json)?\s*\n([\s\S]*?)```/g
  let best: ParsedReport | undefined
  for (const match of output.matchAll(fence)) {
    const block = match[1] ?? ''
    if (!/acceptance|changedFiles|testsAdded|commandsRun|validation|residualRisks/i.test(block)) continue
    try {
      const parsed = JSON.parse(block) as Record<string, unknown>
      const report = canonicalizeReport(parsed)
      if (report) best = report
    } catch {
      // 尝试去包装
      try {
        const unwrapped = block.replace(/^\{?["']?acceptanceReport["']?\s*:\s*/, '').replace(/}\s*$/, '}')
        const parsed = JSON.parse(unwrapped) as Record<string, unknown>
        const report = canonicalizeReport(parsed)
        if (report) best = report
      } catch {
        // 忽略
      }
    }
  }
  return best
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string') return value.split(',').map((s) => s.trim()).filter(Boolean)
  return undefined
}

function canonicalizeReport(raw: Record<string, unknown>): ParsedReport | undefined {
  const keys = Object.keys(raw)
  if (keys.length === 0) return undefined
  const out: ParsedReport = {}
  const changed = raw['changedFiles'] ?? raw['changed_files'] ?? raw['changed-files']
  const tests = raw['testsAddedOrUpdated'] ?? raw['tests_added_or_updated'] ?? raw['tests-added-or-updated']
  const commands = raw['commandsRun'] ?? raw['commands_run'] ?? raw['commands-run']
  const validation = raw['validation']
  const risks = raw['residualRisks'] ?? raw['residual_risks'] ?? raw['residual-risks']
  if (changed !== undefined) out.changedFiles = stringList(changed)
  if (tests !== undefined) out.testsAddedOrUpdated = stringList(tests)
  if (commands !== undefined) {
    if (Array.isArray(commands)) {
      out.commandsRun = commands.map((entry) => {
        if (typeof entry === 'string') return { command: entry }
        if (typeof entry === 'object' && entry !== null) {
          const e = entry as Record<string, unknown>
          return { command: String(e['command'] ?? ''), exitCode: typeof e['exitCode'] === 'number' ? e['exitCode'] : undefined }
        }
        return { command: '' }
      }).filter((entry) => entry.command)
    } else if (typeof commands === 'string') {
      out.commandsRun = commands.split('\n').filter(Boolean).map((command) => ({ command }))
    }
  }
  if (validation !== undefined && Array.isArray(validation)) {
    out.validation = validation.map((entry) => {
      if (typeof entry === 'string') return { name: entry }
      if (typeof entry === 'object' && entry !== null) {
        const e = entry as Record<string, unknown>
        return { name: String(e['name'] ?? ''), status: e['status'] !== undefined ? String(e['status']) : undefined, detail: e['detail'] !== undefined ? String(e['detail']) : undefined }
      }
      return { name: '' }
    }).filter((entry) => entry.name)
  }
  if (risks !== undefined) out.residualRisks = stringList(risks)
  if (raw['noStagedFiles'] !== undefined) out.noStagedFiles = raw['noStagedFiles'] === true || raw['noStagedFiles'] === 'true'
  return out
}

/** 一条验证命令的执行结果。 */
export interface VerifyResult {
  passed: boolean
  output: string
  error?: string
}

/** 在宿主执行一条验证命令（`gate` 或 acceptance.verify）。 */
export function runVerification(command: string, cwd: string, timeoutMs = DEFAULT_GATE_TIMEOUT_MS, signal?: AbortSignal): Promise<VerifyResult> {
  return new Promise((resolve) => {
    execFile(
      '/bin/sh',
      ['-c', command],
      { cwd, timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, signal },
      (error, stdout, stderr) => {
        const output = `${stdout ?? ''}${stderr ? `\n${stderr}` : ''}`.trim()
        if (error) {
          resolve({ passed: false, output, error: String((error as Error).message ?? error) })
        } else {
          resolve({ passed: true, output })
        }
      },
    )
  })
}

/** 汇总 evidence 状态。 */
export function computeEvidenceStatus(
  acceptance: ResolvedAcceptance,
  report: ParsedReport | undefined,
  verify: Array<VerifyResult | undefined>,
  review: { required?: boolean; reviewed?: boolean },
): EvidenceStatus {
  if (acceptance.level === 'none') return 'claimed'
  if (!report) return 'claimed'
  if (acceptance.level === 'attested') {
    if (report.changedFiles || report.testsAddedOrUpdated || report.commandsRun) return 'attested'
    return 'claimed'
  }
  // checked / verified 的结构检查
  const evidenceOk = (acceptance.evidence.length === 0) || (
    (!acceptance.evidence.includes('changed-files') || report.changedFiles !== undefined) &&
    (!acceptance.evidence.includes('tests-added') || report.testsAddedOrUpdated !== undefined) &&
    (!acceptance.evidence.includes('commands-run') || report.commandsRun !== undefined) &&
    (!acceptance.evidence.includes('residual-risks') || report.residualRisks !== undefined) &&
    (!acceptance.evidence.includes('no-staged-files') || report.noStagedFiles !== undefined)
  )
  if (!evidenceOk) return 'rejected'
  if (acceptance.level === 'verified') {
    if (verify.some((v) => v !== undefined && !v.passed)) return 'rejected'
    if (verify.every((v) => v !== undefined)) return 'verified'
    return 'checked'
  }
  if (review?.required) {
    if (review.reviewed) return 'reviewed'
    return 'review-required'
  }
  return 'checked'
}
