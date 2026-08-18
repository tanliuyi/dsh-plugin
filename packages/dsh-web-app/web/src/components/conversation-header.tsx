import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { ChevronDownIcon, ChevronRightIcon, FolderIcon, LoaderCircleIcon } from 'lucide-react'
import { useDsh } from '../dsh/store'
import type { JobView } from '../dsh/api'
import { cn } from '../lib/utils'
import { useThreadNavigation } from '../router-navigation'
import { TooltipIconButton } from './assistant-ui/tooltip-icon-button'

function workspaceLabel(path?: string): string {
  if (!path) return ''
  return path.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? path
}

/** Stable empty list so a session with no jobs keeps one array identity. */
const NO_TASKS: readonly JobView[] = []

/** A job the registry still holds open, and whose duration therefore ticks. */
function isLive(job: JobView): boolean {
  return job.status === 'running' || job.status === 'stopping'
}

/**
 * Status marker semantics, aligned with the upstream StateDot palette:
 * running takes the blue ongoing dot, stopping/killed the amber warning,
 * completed the green done dot and failed the red error dot.
 */
function dotClass(status: JobView['status']): string {
  switch (status) {
    case 'running': return 'bg-sky-500'
    case 'stopping': return 'bg-amber-500'
    case 'completed': return 'bg-emerald-500'
    case 'killed': return 'bg-amber-500'
    case 'failed': return 'bg-red-500'
  }
}

/** Human status word for the row and its accessible name. */
function statusLabel(status: JobView['status']): string {
  switch (status) {
    case 'running': return 'running'
    case 'stopping': return 'stopping'
    case 'completed': return 'completed'
    case 'killed': return 'cancelled'
    case 'failed': return 'failed'
  }
}

/**
 * Elapsed time in at most two adjacent units. A background job that outlives
 * an hour is already exceptional, so hours is the widest unit — beyond that
 * the figure stays in hours rather than growing a day vocabulary.
 */
function formatDuration(elapsedMs: number): string {
  const total = Math.max(0, Math.floor(elapsedMs / 1_000))
  const seconds = total % 60
  const minutes = Math.floor(total / 60) % 60
  const hours = Math.floor(total / 3_600)
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

/**
 * Live rows first in start order, then settled rows newest-first. Two jobs
 * that settled in the same millisecond fall back to start order, so the sort
 * never depends on the store's map iteration.
 */
function ordered(jobs: readonly JobView[]): JobView[] {
  return [...jobs].sort((left, right) => {
    const liveLeft = isLive(left)
    if (liveLeft !== isLive(right)) return liveLeft ? -1 : 1
    if (liveLeft) return left.startedAt - right.startedAt
    const finished = (right.finishedAt ?? right.startedAt) - (left.finishedAt ?? left.startedAt)
    return finished !== 0 ? finished : left.startedAt - right.startedAt
  })
}

/**
 * Session-header entry point for this session's background jobs, mirroring
 * the upstream `JobListAction`: it renders nothing until the session has at
 * least one job, and lists kind, label, status (or the producer's detail) and
 * a live/frozen elapsed duration under a count trigger.
 */
function JobStatusBar() {
  const currentSessionId = useDsh((state) => state.currentSessionId)
  const jobsBySession = useDsh((state) => state.jobsBySession)
  const jobs = currentSessionId ? (jobsBySession[currentSessionId] ?? NO_TASKS) : NO_TASKS
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)

  const rows = useMemo(() => ordered(jobs), [jobs])
  const liveCount = useMemo(() => jobs.filter(isLive).length, [jobs])

  useEffect(() => {
    if (!open) return
    const closeOutside = (event: PointerEvent): void => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) {
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => { document.removeEventListener('pointerdown', closeOutside) }
  }, [open])

  // The clock only runs while an open list is showing something that moves.
  useEffect(() => {
    if (!open || liveCount === 0) return
    setNow(Date.now())
    const timer = setInterval(() => { setNow(Date.now()) }, 1_000)
    return () => { clearInterval(timer) }
  }, [open, liveCount])

  // The last job disappearing removes this control; close first so focus does
  // not vanish from an unmounting node.
  useEffect(() => {
    if (jobs.length === 0 && open) setOpen(false)
  }, [jobs.length, open])

  if (jobs.length === 0) return null

  const liveKey = liveCount > 0
    ? (liveCount === 1 ? 'live.one' : 'live.other')
    : (jobs.length === 1 ? 'idle.one' : 'idle.other')
  const countLabel = liveKey === 'live.one' ? '1 background job running'
    : liveKey === 'live.other' ? `${liveCount} background jobs running`
    : liveKey === 'idle.one' ? '1 background job'
    : `${jobs.length} background jobs`

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== 'Escape' || !open) return
    event.preventDefault()
    setOpen(false)
    triggerRef.current?.focus()
  }

  return (
    <div
      ref={rootRef}
      data-slot="aui_thread-job-status"
      className="relative shrink-0"
      onKeyDown={onKeyDown}
    >
      <button
        ref={triggerRef}
        type="button"
        className="text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 inline-flex min-h-7 items-center gap-0.5 rounded-md px-1 text-xs transition-colors"
        aria-expanded={open}
        aria-label={countLabel}
        onClick={() => {
          // Sample the clock in the same commit that opens the list: the
          // mount-time value predates every job, so the first painted frame
          // would otherwise clamp a long-running row to zero.
          setNow(Date.now())
          setOpen((current) => !current)
        }}
      >
        {liveCount > 0 ? (
          <span aria-hidden className="bg-sky-500 size-2 animate-pulse rounded-full" />
        ) : null}
        <span className="mx-1">{countLabel}</span>
        <ChevronDownIcon
          className={cn('size-3.5 transition-transform duration-120', open && 'rotate-180')}
          aria-hidden="true"
        />
      </button>
      {open ? (
        <ul
          role="list"
          aria-label="Background jobs"
          className="bg-popover text-popover-foreground absolute top-[calc(100%+5px)] left-0 z-50 flex max-h-[min(420px,calc(100vh-140px))] w-84 max-w-[min(400px,calc(100vw-32px))] flex-col gap-px overflow-auto rounded-xl border p-1 shadow-md"
        >
          {rows.map((job) => {
            const live = isLive(job)
            const elapsed = live ? now - job.startedAt : (job.finishedAt ?? job.startedAt) - job.startedAt
            const duration = formatDuration(elapsed)
            const status = statusLabel(job.status)
            return (
              <li
                key={job.id}
                className={cn(
                  'flex w-full min-h-8 items-center gap-2 rounded-lg px-2 py-1.5 text-[13px] leading-[18px]',
                  !live && 'text-muted-foreground',
                )}
              >
                <span
                  aria-hidden
                  className={cn('size-2.5 shrink-0 rounded-full', dotClass(job.status), live && 'animate-pulse')}
                />
                <span className="bg-muted text-muted-foreground shrink-0 rounded-md px-1.5 text-[11px] leading-[18px]">
                  {job.kind}
                </span>
                <span
                  className="min-w-0 flex-1 overflow-hidden font-mono text-nowrap text-ellipsis"
                  title={job.label}
                >
                  {job.label}
                </span>
                <span
                  className="text-muted-foreground max-w-[40%] shrink-0 overflow-hidden text-[11px] leading-[18px] text-nowrap text-ellipsis"
                  title={job.detail ?? status}
                >
                  {job.detail ?? status}
                </span>
                <span
                  className="text-muted-foreground shrink-0 text-[11px] leading-[18px] tabular-nums"
                  title={live ? `Running for ${duration}` : `Took ${duration}`}
                >
                  {duration}
                </span>
              </li>
            )
          })}
        </ul>
      ) : null}
    </div>
  )
}

export function ConversationHeader() {
  const currentSessionId = useDsh((state) => state.currentSessionId)
  const sessions = useDsh((state) => state.sessions)
  const navigateToThread = useThreadNavigation()
  const current = sessions.find((session) => session.sessionId === currentSessionId)

  if (!current || current.blank) return null

  const ancestry: typeof sessions = []
  const seen = new Set<string>()
  let cursor: typeof current | undefined = current
  while (cursor && !seen.has(cursor.sessionId)) {
    seen.add(cursor.sessionId)
    ancestry.unshift(cursor)
    const parentSessionId: string | undefined = cursor.parentSessionId
    cursor = parentSessionId
      ? sessions.find((session) => session.sessionId === parentSessionId)
      : undefined
  }

  return (
    <header
      data-slot="aui_thread-header"
      className="bg-background relative z-10 flex min-h-12 shrink-0 items-center gap-2 border-b px-4 py-2 md:px-5"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <nav
          aria-label="Session hierarchy"
          className="flex min-w-0 items-center gap-1 overflow-hidden whitespace-nowrap"
        >
          {ancestry.map((session, index) => {
            const last = index === ancestry.length - 1
            return (
              <span key={session.sessionId} className="flex min-w-0 items-center gap-1">
                {index > 0 ? (
                  <ChevronRightIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden="true" />
                ) : null}
                <button
                  type="button"
                  disabled={last}
                  aria-current={last ? 'page' : undefined}
                  onClick={() => { if (!last) void navigateToThread(session.sessionId) }}
                  className={last
                    ? 'text-foreground max-w-56 truncate px-1 text-sm font-medium'
                    : 'text-muted-foreground hover:bg-muted max-w-44 truncate rounded-md px-1.5 py-1 text-sm transition-colors'}
                >
                  {session.title}
                </button>
              </span>
            )
          })}
        </nav>

        <JobStatusBar />
      </div>

      {current.running ? (
        <span
          data-slot="aui_thread-header-running"
          className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs"
          aria-label="Thread running"
        >
          <LoaderCircleIcon className="size-3.5 animate-spin" aria-hidden="true" />
          <span className="hidden sm:inline">Running</span>
        </span>
      ) : null}

      <TooltipIconButton
        tooltip="Copy session path"
        type="button"
        variant="ghost"
        size="icon"
        className="ml-2 hidden size-7 md:inline-flex"
        aria-label="Copy session path"
        onClick={() => {
          void navigator.clipboard?.writeText(current.cwd ?? current.sessionId)
        }}
      >
        <FolderIcon className="size-3.5" />
      </TooltipIconButton>
    </header>
  )
}