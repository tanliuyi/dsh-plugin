/**
 * 状态格式化：`subagents({ action: "status" })` 的文本视图（fleet / transcript）。
 */

import type { Details, FleetEntry, RunRecord } from '../types.ts'
import type { RunStore } from './store.ts'
import { formatDuration } from '../util.ts'

const STATE_LABEL: Record<string, string> = {
  queued: 'queued',
  running: 'running',
  paused: 'paused',
  needs_attention: 'needs attention',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
  timed_out: 'timed out',
}

/** 单条 child 行。 */
function childLine(run: RunRecord, child: RunRecord['children'][number]): string {
  const elapsed = (child.endedAt ?? Date.now()) - child.startedAt
  const tokens = child.totalTokens !== undefined ? ` · ↓ ${child.totalTokens} tokens` : ''
  const brief = child.followUpBrief ? ` · follow-up queued` : ''
  const awaiting = child.awaitingSupervisor ? ` · awaiting supervisor reply` : ''
  return `    ${child.key ? `${child.key}: ` : ''}${child.agent} · ${STATE_LABEL[child.status] ?? child.status}${elapsed >= 0 ? ` · ${formatDuration(elapsed)}` : ''}${tokens}${brief}${awaiting}`
}

/** 单条运行块。 */
function runBlock(run: RunRecord, includeChildren: boolean): string[] {
  const lines: string[] = []
  const elapsed = (run.endedAt ?? Date.now()) - run.startedAt
  const mode = run.mode === 'workflow' ? `workflow · ${run.goal ? `goal: ${run.goal.slice(0, 80)}` : run.children.length > 0 ? `${run.children.length} steps` : ''}` : run.agent
  lines.push(`● ${run.id} · ${mode} · ${STATE_LABEL[run.state] ?? run.state} · ${formatDuration(elapsed)}${run.totalTokens ? ` · ↓ ${run.totalTokens} tokens` : ''}`)
  if (includeChildren) {
    for (const child of run.children) {
      if (child.status === 'queued' || child.status === 'running') lines.push(childLine(run, child))
    }
  }
  return lines
}

/** 全部运行状态（fleet 视图）。 */
export function formatStatus(store: RunStore, view?: 'fleet' | 'transcript', id?: string, lines = 80): { text: string; details: Details } {
  if (id) {
    const run = store.find(id)
    if (!run) return { text: `run ${id} not found`, details: { kind: 'status', results: [] } }
    const block = runBlock(run, true)
    if (view === 'transcript') {
      const child = run.children.at(-1)
      const outputFile = child?.outputFile
      block.push('', `Transcript tail (${Math.min(lines, 500)} lines):`)
      block.push(outputFile ? `  see ${outputFile}` : child?.output ? child.output.split('\n').slice(-Math.min(lines, 500)).map((l) => `  ${l}`).join('\n') : '  (no transcript)')
    }
    return { text: block.join('\n'), details: store.detailsOf(run) }
  }
  const runs = store.list()
  const active = runs.filter((run) => run.active)
  if (runs.length === 0) {
    return {
      text: 'No subagent runs in this session.\n\nNext steps:\n- `subagents({ agent: "scout", task: "..." })` to launch one child\n- `subagents({ workflowScript: \`return runs.run("main", { agent: "reviewer", task: "..." })\` })` for a workflow\n- `subagents({ action: "list" })` to browse agents',
      details: { kind: 'status', results: [], totalActive: 0 },
    }
  }
  const linesOut: string[] = []
  if (view === 'fleet') {
    const entries = store.fleetEntries()
    linesOut.push(`Fleet: ${active.length} active run(s)`)
    for (const entry of entries) {
      linesOut.push(`  ${entry.agent} · ${entry.state} · ${formatDuration(entry.elapsedMs)}${entry.tokens ? ` · ↓ ${entry.tokens} tokens` : ''}${entry.goal ? ` · ${entry.goal.slice(0, 60)}` : ''}`)
    }
  } else {
    linesOut.push(`${active.length} active run(s), ${runs.length} total`)
    for (const run of runs.slice(0, 20)) {
      linesOut.push(...runBlock(run, view === 'transcript'))
    }
  }
  return {
    text: linesOut.join('\n'),
    details: { kind: 'status', results: [], totalActive: active.length, fleet: store.fleetEntries() },
  }
}

/** 运行完成后的单行摘要。 */
export function formatResultSummary(run: RunRecord): string {
  const results = run.results
  if (results.length === 0) {
    const base = `${run.mode === 'workflow' ? 'workflow' : run.agent} · ${STATE_LABEL[run.state] ?? run.state}`
    return run.stopReason ? `${base} — ${truncateReason(run.stopReason)}` : base
  }
  const lines = results.map((result) => {
    const line = `${result.status === 'completed' ? '✓' : '✗'} ${result.agent} · ${STATE_LABEL[result.status] ?? result.status}`
    const reason = result.stopReason && result.status !== 'completed' ? ` — ${truncateReason(result.stopReason)}` : ''
    return `${line}${reason}`
  })
  if (run.totalTokens) lines.push(`Tokens: ${run.totalTokens}`)
  const childReasons = results.map((result) => result.stopReason).filter(Boolean)
  if (run.stopReason && childReasons.length === 0 && (run.state === 'failed' || run.state === 'timed_out')) {
    lines.push(`  ${truncateReason(run.stopReason)}`)
  }
  return lines.join('\n')
}

function truncateReason(reason: string): string {
  return reason.length > 500 ? `${reason.slice(0, 500)}…` : reason
}

/** FleetEntry 的详情字段（供 details.fleet 使用）。 */
export function fleetEntriesOf(runs: RunRecord[]): FleetEntry[] {
  const out: FleetEntry[] = []
  for (const run of runs) {
    if (!run.active) continue
    for (const child of run.children) {
      if (child.status === 'queued' || child.status === 'running') {
        out.push({
          agent: child.agent,
          state: child.status,
          elapsedMs: Date.now() - child.startedAt,
          tokens: child.totalTokens,
          goal: run.goal,
        })
      }
    }
  }
  return out
}
