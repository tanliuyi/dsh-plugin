import { ChevronRightIcon, FolderIcon, LoaderCircleIcon, PanelRightCloseIcon, PanelRightOpenIcon } from 'lucide-react'
import { useDsh } from '../dsh/store'
import { useThreadNavigation } from '../router-navigation'
import { TooltipIconButton } from './assistant-ui/tooltip-icon-button'
import { useSessionPanel } from './session-panel'

export function ConversationHeader() {
  const currentSessionId = useDsh((state) => state.currentSessionId)
  const sessions = useDsh((state) => state.sessions)
  const navigateToThread = useThreadNavigation()
  const { open: sessionPanelOpen, setOpen: setSessionPanelOpen } = useSessionPanel()
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
      className="bg-background relative z-10 flex min-h-12 shrink-0 items-center gap-2 border-border border-b px-4 py-2 md:px-5"
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
      </div>

      <TooltipIconButton
        tooltip={sessionPanelOpen ? 'Collapse session panel' : 'Expand session panel'}
        type="button"
        variant="ghost"
        size="icon"
        className="session-panel-trigger size-7 shrink-0"
        aria-label={sessionPanelOpen ? 'Collapse session panel' : 'Expand session panel'}
        aria-controls="session-panel"
        aria-expanded={sessionPanelOpen}
        onClick={() => setSessionPanelOpen(!sessionPanelOpen)}
      >
        {sessionPanelOpen ? (
          <PanelRightCloseIcon className="size-4" />
        ) : (
          <PanelRightOpenIcon className="size-4" />
        )}
      </TooltipIconButton>
    </header>
  )
}
