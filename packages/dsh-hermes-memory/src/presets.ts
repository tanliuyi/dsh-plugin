/** Minimal-preset isolation for host-mounted Hermes capabilities. */

import type { Context } from '@deepseek-ai/cordis'

export const MINIMAL_PRESET_ID = 'minimal'

export const HERMES_GLOBAL_TOOLS = [
  'memory_add',
  'memory_replace',
  'memory_remove',
  'memory_search',
  'session_search',
  'skill_manage',
] as const

export interface PresetBearingSession {
  readonly header: { readonly agentPreset?: string }
  readonly events: readonly { type: string; data?: unknown }[]
}

function readSelectedPreset(data: unknown): string | undefined {
  const preset = (data as { agentPreset?: unknown } | undefined)?.agentPreset
  return typeof preset === 'string' ? preset : undefined
}

/** Resolve the newest selected preset, falling back to the creation header. */
export function resolveSessionPreset(session: PresetBearingSession): string | undefined {
  for (let i = session.events.length - 1; i >= 0; i--) {
    const event = session.events[i]
    if (event?.type !== 'agent-preset/selected') continue
    const preset = readSelectedPreset(event.data)
    if (preset !== undefined) return preset
  }
  return session.header.agentPreset
}

export function isMinimalSessionPreset(session: PresetBearingSession): boolean {
  return resolveSessionPreset(session) === MINIMAL_PRESET_ID
}

interface ComposedAgent {
  readonly ctx: Context
  readonly session: { readonly id: string }
}

interface AgentPresetsLike {
  composedPreset(agentCtx: Context): string | undefined
}

interface AgentsLike {
  get(sessionId: string): ComposedAgent | undefined
  list(): ComposedAgent[]
}

interface AgentToolsLike {
  restrict(filter: { deny: string[] }): () => void
}

interface RootEventsLike {
  on(event: string, listener: (...args: any[]) => void): () => void
}

/** Register live-agent tool isolation for the shipped minimal preset. */
export function registerMinimalPresetIsolation(
  ctx: Context,
  ownGlobalTools: readonly string[] = HERMES_GLOBAL_TOOLS,
): () => void {
  const active = new Map<string, { agent: ComposedAgent; dispose: () => void }>()

  const clear = (sessionId: string, agent?: ComposedAgent): void => {
    const current = active.get(sessionId)
    if (!current || (agent && current.agent !== agent)) return
    active.delete(sessionId)
    current.dispose()
  }

  const reconcile = (agent: ComposedAgent): void => {
    const sessionId = agent.session.id
    const current = active.get(sessionId)
    if (current && current.agent !== agent) clear(sessionId)

    const presets = ctx.get('agentPresets') as AgentPresetsLike | undefined
    const minimal = presets?.composedPreset(agent.ctx) === MINIMAL_PRESET_ID
    const installed = active.get(sessionId)
    if (!minimal) {
      clear(sessionId, agent)
      return
    }
    if (installed?.agent === agent) return

    const tools = (agent.ctx as unknown as { tools?: AgentToolsLike }).tools
    if (!tools || typeof tools.restrict !== 'function') return
    active.set(sessionId, { agent, dispose: tools.restrict({ deny: [...ownGlobalTools] }) })
  }

  const root = ctx.root as unknown as RootEventsLike
  const listeners = [
    root.on('agent/created', (payload: { agent: ComposedAgent }) => reconcile(payload.agent)),
    root.on('agent-preset/selected', (sessionId: string) => {
      const agents = ctx.get('agents') as AgentsLike | undefined
      const agent = agents?.get(sessionId)
      if (agent) reconcile(agent)
    }),
    root.on('agent/disposed', (payload: { agent: ComposedAgent }) => clear(payload.agent.session.id, payload.agent)),
  ]

  // Plugin HMR happens after agent/created; rebuild restrictions for live agents.
  const agents = ctx.get('agents') as AgentsLike | undefined
  for (const agent of agents?.list?.() ?? []) reconcile(agent)

  return () => {
    for (const dispose of listeners.reverse()) dispose()
    for (const sessionId of [...active.keys()]) clear(sessionId)
  }
}
