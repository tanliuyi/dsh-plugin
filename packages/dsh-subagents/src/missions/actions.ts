/**
 * Mission 管理动作：create / list / show / update / resolve-decision /
 * attach-run / close。文本输出格式对齐 pi-subagents。
 */

import type { MissionRecord, MissionStore } from './store.ts'

/** mission action 的输入参数。 */
export interface MissionActionInput {
  action: string
  missionId?: string
  mission?: Record<string, unknown> | false
  config?: Record<string, unknown> | string
  summary?: string
  decisionId?: string
  runId?: string
  missionScope?: 'project' | 'global'
}

function fmt(record: MissionRecord): string {
  const title = record.title ?? record.summary ?? record.id
  const lines = [
    `Mission: ${record.id} (${record.status})`,
    `Title: ${title}`,
    `Created: ${new Date(record.createdAt).toISOString()}`,
  ]
  if (record.objective) lines.push(`Objective: ${record.objective}`)
  if (record.goal) lines.push(`Goal mode: enabled${record.budget ? ` (budget ${record.budget.tokens} tokens)` : ''}${record.goalPaused ? ' (paused)' : ''}`)
  if (record.labels?.length) lines.push(`Labels: ${record.labels.join(', ')}`)
  if (record.runs.length) {
    lines.push('Runs:')
    for (const run of record.runs) {
      lines.push(`  - ${run.runId} ${run.agent} ${run.status}${run.key ? ` (${run.key})` : ''}`)
    }
  }
  if (record.decisions.length) {
    lines.push('Decisions:')
    for (const decision of record.decisions) {
      const resolved = decision.resolution ? ` → ${decision.resolution}` : ' (open)'
      lines.push(`  - ${decision.id}: ${decision.question}${resolved}`)
    }
  }
  if (record.receipts.length) {
    lines.push('Receipts:')
    for (const receipt of record.receipts) {
      lines.push(`  - [${receipt.kind}] ${receipt.title} (${receipt.status})${receipt.url ? ` ${receipt.url}` : ''}`)
    }
  }
  if (record.usage.tokens) lines.push(`Usage: ${record.usage.tokens} tokens`)
  return lines.join('\n')
}

/** 校验 mission 创建参数。 */
export function validateMissionInput(input: Record<string, unknown>): { error?: string; normalized?: { title?: string; summary?: string; objective?: string; goal?: boolean; budget?: { tokens: number }; labels?: string[] } } {
  const title = typeof input['title'] === 'string' && input['title'].trim() ? input['title'].trim() : undefined
  const summary = typeof input['summary'] === 'string' && input['summary'].trim() ? input['summary'].trim() : undefined
  if ((title === undefined) === (summary === undefined)) {
    return { error: 'mission requires exactly one non-empty `title` or `summary`' }
  }
  const goal = input['goal'] === true
  const budget = input['budget']
  if (goal) {
    if (typeof budget !== 'object' || budget === null || typeof (budget as Record<string, unknown>)['tokens'] !== 'number') {
      return { error: 'mission goal requires budget: { tokens: <positive integer> }' }
    }
  }
  const labels = Array.isArray(input['labels']) ? input['labels'].map(String) : undefined
  return {
    normalized: {
      title,
      summary,
      objective: typeof input['objective'] === 'string' ? input['objective'] : undefined,
      goal,
      budget: goal && budget ? { tokens: (budget as Record<string, unknown>)['tokens'] as number } : undefined,
      labels,
    },
  }
}

/** 执行一个 mission action，返回文本结果。 */
export async function runMissionAction(
  store: MissionStore,
  input: MissionActionInput,
): Promise<{ text: string; missionId?: string; status?: string }> {
  switch (input.action) {
    case 'mission.create': {
      if (input.mission === false || typeof input.mission !== 'object') {
        return { text: 'mission.create requires a mission object' }
      }
      const validated = validateMissionInput(input.mission as Record<string, unknown>)
      if (validated.error || !validated.normalized) return { text: `mission.create failed: ${validated.error}` }
      const record = await store.create(validated.normalized)
      return { text: fmt(record), missionId: record.id, status: record.status }
    }
    case 'mission.list': {
      const records = await store.list(input.missionScope === 'global' ? 'global' : 'project')
      if (records.length === 0) return { text: 'No missions found.' }
      const lines = records.map((record) => {
        const title = record.title ?? record.summary ?? record.id
        return `- ${record.id} ${record.status} ${title}${record.runs.length ? ` (${record.runs.length} runs)` : ''}`
      })
      return { text: `Missions:\n${lines.join('\n')}` }
    }
    case 'mission.show': {
      if (!input.missionId) return { text: 'mission.show requires missionId' }
      const record = await store.get(input.missionId)
      if (!record) return { text: `mission ${input.missionId} not found` }
      return { text: fmt(record), missionId: record.id, status: record.status }
    }
    case 'mission.update': {
      if (!input.missionId) return { text: 'mission.update requires missionId' }
      const record = await store.get(input.missionId)
      if (!record) return { text: `mission ${input.missionId} not found` }
      const config = typeof input.config === 'string' ? safeParseJson(input.config) : input.config
      if (config) {
        if (typeof config['summary'] === 'string') record.summary = config['summary']
        if (typeof config['objective'] === 'string') record.objective = config['objective']
        if (Array.isArray(config['labels'])) record.labels = config['labels'].map(String)
        if (config['goal'] === false) record.goal = false
        if (typeof config['goal'] === 'object' && config['goal'] !== null) {
          const goal = config['goal'] as Record<string, unknown>
          if (goal['paused'] === true) record.goalPaused = true
          if (goal['paused'] === false) record.goalPaused = false
          if (goal['paused'] === undefined && goal['enabled'] === false) record.goal = false
        }
        if (Array.isArray(config['artifacts'])) {
          for (const artifact of config['artifacts']) {
            if (typeof artifact === 'string' && !record.artifacts.includes(artifact)) record.artifacts.push(artifact)
          }
        }
        if (Array.isArray(config['receipts'])) {
          for (const receipt of config['receipts']) {
            if (typeof receipt === 'object' && receipt !== null) {
              const r = receipt as Record<string, unknown>
              if (typeof r['kind'] === 'string' && typeof r['status'] === 'string' && typeof r['title'] === 'string') {
                record.receipts.push({
                  kind: r['kind'],
                  status: r['status'],
                  title: r['title'],
                  url: typeof r['url'] === 'string' ? r['url'] : undefined,
                  description: typeof r['description'] === 'string' ? r['description'] : undefined,
                  createdAt: Date.now(),
                })
              }
            }
          }
        }
        if (Array.isArray(config['decisions'])) {
          for (const decision of config['decisions']) {
            if (typeof decision === 'object' && decision !== null) {
              const d = decision as Record<string, unknown>
              if (typeof d['question'] === 'string') {
                record.decisions.push({
                  id: typeof d['id'] === 'string' ? d['id'] : `d-${Date.now()}`,
                  question: d['question'],
                  options: Array.isArray(d['options']) ? d['options'].map(String) : undefined,
                  createdAt: Date.now(),
                })
              }
            }
          }
        }
        if (typeof config['nextReadyAction'] === 'string') record.nextReadyAction = config['nextReadyAction']
      }
      if (record.decisions.some((d) => !d.resolution)) {
        if (record.status === 'active' || record.status === 'completed') record.status = 'needs_decision'
      }
      await store.save(record)
      return { text: fmt(record), missionId: record.id, status: record.status }
    }
    case 'mission.resolve-decision': {
      if (!input.missionId || !input.decisionId) return { text: 'mission.resolve-decision requires missionId and decisionId' }
      const record = await store.get(input.missionId)
      if (!record) return { text: `mission ${input.missionId} not found` }
      const decision = record.decisions.find((d) => d.id === input.decisionId)
      if (!decision) return { text: `decision ${input.decisionId} not found` }
      decision.resolution = input.summary ?? ''
      decision.resolvedAt = Date.now()
      if (!record.decisions.some((d) => !d.resolution) && record.status === 'needs_decision') record.status = 'active'
      await store.save(record)
      return { text: `Resolved decision ${input.decisionId} on mission ${record.id}`, missionId: record.id, status: record.status }
    }
    case 'mission.attach-run': {
      if (!input.missionId || !input.runId) return { text: 'mission.attach-run requires missionId and runId' }
      const record = await store.get(input.missionId)
      if (!record) return { text: `mission ${input.missionId} not found` }
      await store.attachRun(input.missionId, {
        runId: input.runId,
        agent: typeof input.config === 'object' && input.config !== null && typeof input.config['agent'] === 'string' ? input.config['agent'] : 'unknown',
        task: typeof input.config === 'object' && input.config !== null && typeof input.config['task'] === 'string' ? input.config['task'] : '',
        status: 'running',
        updatedAt: Date.now(),
      })
      return { text: `Attached run ${input.runId} to mission ${record.id}`, missionId: record.id, status: record.status }
    }
    case 'mission.close': {
      if (!input.missionId) return { text: 'mission.close requires missionId' }
      const record = await store.get(input.missionId)
      if (!record) return { text: `mission ${input.missionId} not found` }
      const status = input.summary ? undefined : undefined
      void status
      await store.close(input.missionId, 'completed', input.summary)
      const updated = await store.get(input.missionId)
      return { text: `Closed mission ${record.id} (completed)`, missionId: record.id, status: updated?.status }
    }
    default:
      return { text: `unknown mission action: ${input.action}` }
  }
}

function safeParseJson(text: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : undefined
  } catch {
    return undefined
  }
}
