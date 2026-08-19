import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from 'react'
import { ActivityIcon, BotIcon, FolderIcon, GitBranchIcon, HashIcon, ListTodoIcon } from 'lucide-react'
import type { JobView, SubagentListEntry } from '../dsh/api'
import { useDsh } from '../dsh/store'
import { cn } from '../lib/utils'
import { useThreadNavigation } from '../router-navigation'

const SESSION_PANEL_STORAGE_KEY = 'dsh.session-panel.open.v1'
const NO_JOBS: readonly JobView[] = []
const NO_SUBAGENTS: readonly SubagentListEntry[] = []

function isLiveJob(job: JobView): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

function jobDotClass(status: JobView['status']): string {
  switch (status) {
    case 'running': return 'bg-sky-500'
    case 'stopping': return 'bg-amber-500'
    case 'completed': return 'bg-emerald-500'
    case 'killed': return 'bg-amber-500'
    case 'failed': return 'bg-red-500'
  }
}

function jobStatusLabel(status: JobView['status']): string {
  switch (status) {
    case 'running': return 'Running'
    case 'stopping': return 'Stopping'
    case 'completed': return 'Completed'
    case 'killed': return 'Cancelled'
    case 'failed': return 'Failed'
  }
}

function formatDuration(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1_000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3_600)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function orderedJobs(jobs: readonly JobView[]): JobView[] {
  return [...jobs].sort((left, right) => {
    const leftLive = isLiveJob(left)
    const rightLive = isLiveJob(right)
    if (leftLive !== rightLive) return leftLive ? -1 : 1
    if (leftLive) return left.startedAt - right.startedAt
    return (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
  })
}

type SessionPanelContextValue = {
  open: boolean
  setOpen: (open: boolean) => void
}

const SessionPanelContext = createContext<SessionPanelContextValue | null>(null)

function readInitialOpen(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(SESSION_PANEL_STORAGE_KEY) === 'true'
  } catch {
    return false
  }
}

export function useSessionPanel(): SessionPanelContextValue {
  const value = useContext(SessionPanelContext)
  if (!value) throw new Error('useSessionPanel must be used inside SessionPanelProvider')
  return value
}

export function SessionPanelProvider({ children }: PropsWithChildren) {
  const [preferredOpen, setPreferredOpen] = useState(readInitialOpen)
  const available = useDsh((state) => {
    const session = state.sessions.find((item) => item.sessionId === state.currentSessionId)
    return session !== undefined && !session.blank
  })
  const open = preferredOpen && available

  const value = useMemo<SessionPanelContextValue>(() => ({
    open,
    setOpen: (next) => {
      setPreferredOpen(next)
      try {
        window.localStorage.setItem(SESSION_PANEL_STORAGE_KEY, String(next))
      } catch {
        // View persistence is best effort.
      }
    },
  }), [open])

  return (
    <SessionPanelContext.Provider value={value}>
      <div
        data-slot="session-panel-layout"
        data-panel-state={open ? 'open' : 'closed'}
        className="session-panel-layout flex min-h-0 flex-1 flex-col border-l border-border"
      >
        {children}
        {available ? <SessionPanel /> : null}
      </div>
    </SessionPanelContext.Provider>
  )
}

function formatUpdatedAt(updatedAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(updatedAt))
}

function DetailRow({ icon, label, value, title }: {
  icon: ReactNode
  label: string
  value: string
  title?: string
}) {
  return (
    <div className="grid grid-cols-[18px_72px_minmax(0,1fr)] items-start gap-2 py-2 text-xs">
      <span className="text-muted-foreground mt-px" aria-hidden="true">{icon}</span>
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words text-foreground" title={title}>{value}</span>
    </div>
  )
}

function ActivityGroup({ title, count, icon, children }: {
  title: string
  count: number
  icon: ReactNode
  children: ReactNode
}) {
  return (
    <section className="group/session-activity py-2.5 first:pt-0">
      <div className="mb-1.5 flex min-h-6 items-center gap-2 px-0.5">
        <span className="text-muted-foreground" aria-hidden="true">{icon}</span>
        <h3 className="text-xs font-medium text-foreground">{title}</h3>
        <span className="text-muted-foreground ml-auto text-[11px] tabular-nums">{count}</span>
      </div>
      {children}
    </section>
  )
}

function BackgroundTaskGroup({ jobs, open }: { jobs: readonly JobView[]; open: boolean }) {
  const rows = useMemo(() => orderedJobs(jobs), [jobs])
  const liveCount = useMemo(() => jobs.filter(isLiveJob).length, [jobs])
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (!open || liveCount === 0) return
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 1_000)
    return () => window.clearInterval(timer)
  }, [liveCount, open])

  return (
    <ActivityGroup title="Background tasks" count={rows.length} icon={<ListTodoIcon className="size-3.5" />}>
      {rows.length > 0 ? (
        <ul className="divide-border divide-y" aria-label="Background tasks">
          {rows.map((job) => {
            const live = isLiveJob(job)
            const elapsed = live
              ? now - job.startedAt
              : (job.finishedAt ?? job.startedAt) - job.startedAt
            return (
              <li key={job.id} className="flex min-w-0 items-start gap-2 py-2">
                <span
                  aria-hidden="true"
                  className={cn('mt-1 size-2 shrink-0 rounded-full', jobDotClass(job.status), live && 'animate-pulse')}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-2">
                    <span className="truncate text-xs font-medium" title={job.label}>{job.label}</span>
                    <span className="text-muted-foreground ml-auto shrink-0 text-[11px] tabular-nums">
                      {formatDuration(elapsed)}
                    </span>
                  </div>
                  <div className="text-muted-foreground mt-0.5 flex min-w-0 gap-1.5 text-[11px] leading-4">
                    <span className="shrink-0">{job.kind}</span>
                    <span aria-hidden="true">·</span>
                    <span className="truncate" title={job.detail ?? jobStatusLabel(job.status)}>
                      {job.detail ?? jobStatusLabel(job.status)}
                    </span>
                  </div>
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-muted-foreground px-0.5 py-1 text-xs">No background tasks</p>
      )}
    </ActivityGroup>
  )
}

function SubagentGroup({ entries }: { entries: readonly SubagentListEntry[] }) {
  const navigateToThread = useThreadNavigation()

  return (
    <ActivityGroup title="Subagents" count={entries.length} icon={<BotIcon className="size-3.5" />}>
      {entries.length > 0 ? (
        <ul className="divide-border divide-y" aria-label="Subagents">
          {entries.map((entry) => {
            if (entry.kind === 'diagnostic') {
              return (
                <li key={entry.id} className="flex min-w-0 items-start gap-2 py-2 text-xs">
                  <span className="mt-1 size-2 shrink-0 rounded-full bg-red-500" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium" title={entry.id}>{entry.id}</p>
                    <p className="text-muted-foreground mt-0.5 text-[11px] capitalize">{entry.reason}</p>
                  </div>
                </li>
              )
            }

            const running = entry.activity === 'running'
            return (
              <li key={entry.id}>
                <button
                  type="button"
                  className="hover:bg-muted/60 focus-visible:bg-muted/60 flex w-full min-w-0 items-start gap-2 rounded-sm py-2 text-left outline-none transition-colors"
                  onClick={() => void navigateToThread(entry.id)}
                >
                  <span
                    className={cn('mt-1 size-2 shrink-0 rounded-full', running ? 'bg-sky-500 animate-pulse' : 'bg-muted-foreground/45')}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium" title={entry.label ?? entry.id}>
                      {entry.label ?? entry.id}
                    </span>
                    <span className="text-muted-foreground mt-0.5 flex gap-1.5 text-[11px] leading-4">
                      <span className="capitalize">{entry.activity}</span>
                      <span aria-hidden="true">·</span>
                      <span>{entry.mode === 'one-shot' ? 'One shot' : 'Continuable'}</span>
                    </span>
                  </span>
                </button>
              </li>
            )
          })}
        </ul>
      ) : (
        <p className="text-muted-foreground px-0.5 py-1 text-xs">No subagents</p>
      )}
    </ActivityGroup>
  )
}

function SessionPanel() {
  const { open } = useSessionPanel()
  const currentSessionId = useDsh((state) => state.currentSessionId)
  const session = useDsh((state) => state.sessions.find((item) => item.sessionId === currentSessionId))
  const jobs = useDsh((state) => currentSessionId ? (state.jobsBySession[currentSessionId] ?? NO_JOBS) : NO_JOBS)
  const catalogParentId = session?.origin === 'subagent' && session.parentSessionId
    ? session.parentSessionId
    : currentSessionId
  const subagents = useDsh((state) => catalogParentId
    ? (state.subagentsByParent[catalogParentId]?.entries ?? NO_SUBAGENTS)
    : NO_SUBAGENTS)
  const loadSubagents = useDsh((state) => state.loadSubagents)

  useEffect(() => {
    if (!open || !catalogParentId) return
    void loadSubagents(catalogParentId).catch(() => {})
  }, [catalogParentId, loadSubagents, open])

  return (
    <aside
      id="session-panel"
      data-slot="session-panel"
      data-state={open ? 'open' : 'closed'}
      aria-label="Session panel"
      aria-hidden={!open}
      inert={!open ? true : undefined}
      className="session-panel border-border bg-background/95 fixed z-30 flex flex-col overflow-hidden border shadow-lg backdrop-blur-sm"
    >
      <div className="border-border flex min-h-11 shrink-0 items-center border-b px-3.5">
        <h2 className="truncate text-sm font-medium">Session</h2>
        {session?.running ? (
          <span className="ml-auto inline-flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-2 animate-pulse rounded-full bg-sky-500" aria-hidden="true" />
            Running
          </span>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3.5 py-2">
        {session ? (
          <>
            <p className="mb-2 break-words text-sm font-medium leading-5">{session.title}</p>
            <div className="divide-border divide-y">
              <DetailRow
                icon={<ActivityIcon className="size-3.5" />}
                label="Updated"
                value={formatUpdatedAt(session.updatedAt)}
              />
              <DetailRow
                icon={<FolderIcon className="size-3.5" />}
                label="Workspace"
                value={session.cwd ?? 'Unavailable'}
                title={session.cwd}
              />
              <DetailRow
                icon={<HashIcon className="size-3.5" />}
                label="Session ID"
                value={session.sessionId}
                title={session.sessionId}
              />
              {session.parentSessionId ? (
                <DetailRow
                  icon={<GitBranchIcon className="size-3.5" />}
                  label="Parent"
                  value={session.parentSessionId}
                  title={session.parentSessionId}
                />
              ) : null}
            </div>
            <div className="border-border divide-border mt-2 divide-y border-t">
              <SubagentGroup entries={subagents} />
              <BackgroundTaskGroup jobs={jobs} open={open} />
            </div>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">No active session</p>
        )}
      </div>
    </aside>
  )
}
