/**
 * 调度管理动作：schedule.create / list / show / history / pause / resume /
 * run / run-due / delete。
 */

import type { SubagentsParams } from '../types.ts'
import type { ScheduleManager } from '../schedules/manager.ts'

/** 执行一个调度管理动作，返回文本结果。 */
export async function runScheduleAction(
  manager: ScheduleManager,
  params: SubagentsParams,
  action: string,
): Promise<{ text: string; details: import('../types.ts').Details }> {
  const id = params.id
  switch (action) {
    case 'schedule.create': {
      if (!params.workflowScript) return { text: 'schedule.create requires workflowScript', details: { kind: 'error', results: [] } }
      const result = await manager.create({
        id: params.name ? undefined : id,
        name: params.name ?? id ?? '',
        workflowScript: params.workflowScript,
        at: params.at,
        every: params.every,
        catchUp: (params as { catchUp?: 'latest' | 'none' }).catchUp,
        creatorSessionId: (params as { creatorSessionId?: string }).creatorSessionId,
        cwd: (params as { cwd?: string }).cwd,
      })
      if (result.error || !result.definition) return { text: `schedule.create failed: ${result.error}`, details: { kind: 'error', results: [] } }
      const def = result.definition
      const next = def.nextRunAt ? new Date(def.nextRunAt).toISOString() : '—'
      return {
        text: `Created schedule ${def.id} ("${def.name}")\nNext run: ${next}\nInterval: ${def.every ?? 'one-shot'}`,
        details: { kind: 'schedule', results: [] },
      }
    }
    case 'schedule.list': {
      const schedules = await manager.list()
      if (schedules.length === 0) return { text: 'No schedules.', details: { kind: 'schedule', results: [] } }
      const lines = schedules.map((def) => {
        const next = def.nextRunAt ? new Date(def.nextRunAt).toISOString() : '—'
        return `- ${def.id} "${def.name}" ${def.paused ? 'paused' : def.every ? `every ${def.every}` : 'one-shot'} · next ${next} · ${def.runCount} runs`
      })
      return { text: `Schedules:\n${lines.join('\n')}`, details: { kind: 'schedule', results: [] } }
    }
    case 'schedule.show': {
      if (!id) return { text: 'schedule.show requires id', details: { kind: 'error', results: [] } }
      const def = await manager.get(id)
      if (!def) return { text: `schedule ${id} not found`, details: { kind: 'error', results: [] } }
      return {
        text: `Schedule ${def.id} ("${def.name}")\n${def.every ? `Every: ${def.every}` : `At: ${def.at ?? '—'}`}\nPaused: ${def.paused}\nRuns: ${def.runCount}\nLast run: ${def.lastRunAt ? new Date(def.lastRunAt).toISOString() : '—'}\nNext run: ${def.nextRunAt ? new Date(def.nextRunAt).toISOString() : '—'}\n\nScript:\n${def.workflowScript.slice(0, 2000)}`,
        details: { kind: 'schedule', results: [] },
      }
    }
    case 'schedule.history': {
      if (!id) return { text: 'schedule.history requires id', details: { kind: 'error', results: [] } }
      const events = await manager.history(id)
      return { text: events.length ? `Schedule ${id} history:\n${events.join('\n')}` : `No history for schedule ${id}`, details: { kind: 'schedule', results: [] } }
    }
    case 'schedule.pause': {
      if (!id) return { text: 'schedule.pause requires id', details: { kind: 'error', results: [] } }
      const result = await manager.pause(id)
      return { text: result.ok ? `Paused schedule ${id}` : result.error ?? 'failed', details: { kind: 'schedule', results: [] } }
    }
    case 'schedule.resume': {
      if (!id) return { text: 'schedule.resume requires id', details: { kind: 'error', results: [] } }
      const result = await manager.resume(id)
      return { text: result.ok ? `Resumed schedule ${id}` : result.error ?? 'failed', details: { kind: 'schedule', results: [] } }
    }
    case 'schedule.run': {
      if (!id) return { text: 'schedule.run requires id', details: { kind: 'error', results: [] } }
      const result = await manager.runNow(id)
      return { text: result.ok ? `Started schedule ${id} (run ${result.runId})` : result.error ?? 'failed', details: { kind: 'schedule', results: [] } }
    }
    case 'schedule.run-due': {
      const started = await manager.runDue()
      return { text: started.length ? `Started ${started.length} due run(s): ${started.join(', ')}` : 'No due schedules.', details: { kind: 'schedule', results: [] } }
    }
    case 'schedule.delete': {
      if (!id) return { text: 'schedule.delete requires id', details: { kind: 'error', results: [] } }
      const result = await manager.delete(id)
      return { text: result.ok ? `Deleted schedule ${id}` : result.error ?? 'failed', details: { kind: 'schedule', results: [] } }
    }
    default:
      return { text: `unknown schedule action: ${action}`, details: { kind: 'error', results: [] } }
  }
}
