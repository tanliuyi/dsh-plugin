import { useCallback, useEffect, useState, type CSSProperties } from 'react'
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router'
import { MenuIcon, Settings2Icon } from 'lucide-react'
import { useDsh } from './dsh/store'
import { connectDownlinks } from './dsh/stream'
import { TooltipIconButton } from './components/assistant-ui/tooltip-icon-button'
import { Button } from './components/ui/button'
import { SettingsDialog } from './components/settings-dialog'
import { ThreadList } from './components/assistant-ui/thread-list'
import { DshRuntimeProvider } from './runtime/DshRuntime'
import { threadIdFromPathname } from './router-navigation'
import { useResizableRegion } from './use-resizable-region'
import {
  DEFAULT_THREAD_LIST_SIDEBAR_WIDTH,
  MIN_THREAD_LIST_SIDEBAR_WIDTH,
  getThreadListSidebarMaximum,
  readThreadListSidebarWidth,
  writeThreadListSidebarWidth,
} from './thread-list-sidebar-width'

/** Keep a removed current session from leaving the app on a stale thread URL. */
function RouteSelectionGuard() {
  const pathname = useRouterState({ select: (state) => state.location.pathname })
  const navigate = useNavigate()
  const currentSessionId = useDsh((state) => state.currentSessionId)
  const booting = useDsh((state) => state.booting)

  useEffect(() => {
    if (booting || currentSessionId !== null || threadIdFromPathname(pathname) === null) return
    void navigate({ to: '/', replace: true })
  }, [booting, currentSessionId, navigate, pathname])

  return null
}

function ThreadListSidebar({
  open,
  settingsOpen,
  onOpenSettings,
}: {
  open: boolean
  settingsOpen: boolean
  onOpenSettings: () => void
}) {
  const [width, setWidth] = useState(() => {
    try {
      return readThreadListSidebarWidth(window.localStorage)
    } catch {
      return DEFAULT_THREAD_LIST_SIDEBAR_WIDTH
    }
  })
  const commitWidth = useCallback((nextWidth: number) => {
    setWidth(nextWidth)
    try {
      writeThreadListSidebarWidth(window.localStorage, nextWidth)
    } catch {
      // Access to local storage itself can be blocked by the browser.
    }
  }, [])
  const resize = useResizableRegion<HTMLElement>({
    value: width,
    min: MIN_THREAD_LIST_SIDEBAR_WIDTH,
    getMaxSize: () => getThreadListSidebarMaximum(window.innerWidth),
    direction: 1,
    onCommit: commitWidth,
  })

  return (
    <aside
      ref={resize.regionRef}
      data-slot="aui_thread-list-sidebar"
      data-state={open ? 'open' : 'closed'}
      style={{ '--resizable-region-size': `${resize.initialSize}px` } as CSSProperties}
      className={`${open ? 'fixed inset-y-0 start-0 z-40 flex shadow-xl' : 'hidden'} min-h-0 w-[min(280px,85vw)] shrink-0 flex-col overflow-hidden bg-muted/20 md:relative md:flex md:w-[var(--resizable-region-size)] md:shadow-none`}
    >
      <ThreadList />
      <Button
        type="button"
        variant="ghost"
        data-slot="aui_sidebar-settings"
        aria-label="打开设置"
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        className="mx-2 mb-2 h-9 shrink-0 justify-start gap-2 px-2 text-muted-foreground hover:text-foreground"
        onClick={onOpenSettings}
      >
        <Settings2Icon className="size-4" aria-hidden="true" />
        <span>设置</span>
      </Button>
      <div
        ref={resize.separatorRef}
        role="separator"
        aria-label="Resize workspace sidebar"
        aria-orientation="vertical"
        aria-valuemin={MIN_THREAD_LIST_SIDEBAR_WIDTH}
        aria-valuemax={resize.initialMax}
        aria-valuenow={resize.initialSize}
        aria-valuetext={`${resize.initialSize} pixels`}
        tabIndex={0}
        className="group absolute inset-y-0 end-0 z-20 hidden w-3 cursor-col-resize touch-none items-center justify-end outline-none md:flex"
        onPointerDown={resize.onPointerDown}
        onKeyDown={resize.onKeyDown}
        onDoubleClick={() => resize.commitSize(DEFAULT_THREAD_LIST_SIDEBAR_WIDTH)}
      >
        <span className="h-full w-px bg-border transition-colors group-hover:bg-foreground/35 group-focus-visible:bg-ring group-focus-visible:ring-2 group-focus-visible:ring-ring/30" />
      </div>
    </aside>
  )
}

/** Root route layout: runtime, sidebar, settings and the route outlet. */
export default function App() {
  const error = useDsh((state) => state.error)
  const currentSessionId = useDsh((state) => state.currentSessionId)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    const preferredSessionId = threadIdFromPathname(window.location.pathname) ?? undefined
    void useDsh.getState().boot(preferredSessionId)
    connectDownlinks()
  }, [])

  useEffect(() => {
    setSidebarOpen(false)
  }, [currentSessionId])

  const openSettings = useCallback(() => {
    setSidebarOpen(false)
    setSettingsOpen(true)
  }, [])

  return (
    <DshRuntimeProvider>
      <RouteSelectionGuard />
      <div className="flex h-dvh overflow-hidden">
        {sidebarOpen && (
          <button
            type="button"
            aria-label="Close workspace sidebar"
            className="fixed inset-0 z-30 bg-black/20 md:hidden"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        <ThreadListSidebar
          open={sidebarOpen}
          settingsOpen={settingsOpen}
          onOpenSettings={openSettings}
        />
        <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <TooltipIconButton
            tooltip="Open workspace sidebar"
            type="button"
            variant="outline"
            size="icon"
            className="absolute start-3 top-3 z-20 size-8 rounded-full bg-background/90 shadow-sm md:hidden"
            aria-label="Open workspace sidebar"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen(true)}
          >
            <MenuIcon className="size-4" />
          </TooltipIconButton>
          {error && (
            <div role="alert" className="absolute inset-x-0 top-0 z-50 border-b border-destructive/40 bg-destructive/10 px-4 py-1.5 text-destructive">
              {error}
            </div>
          )}
          <div className="flex min-h-0 flex-1 flex-col">
            <Outlet />
          </div>
          <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        </main>
      </div>
    </DshRuntimeProvider>
  )
}
