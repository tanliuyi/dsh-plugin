import { useEffect, useState } from 'react'
import { MenuIcon, Settings2Icon } from 'lucide-react'
import { useDsh } from './dsh/store'
import { connectDownlinks } from './dsh/stream'
import { TooltipIconButton } from './components/assistant-ui/tooltip-icon-button'
import { SettingsDialog } from './components/settings-dialog'
import { ConversationHeader } from './components/conversation-header'
import { Thread } from './components/assistant-ui/thread'
import { ThreadList } from './components/assistant-ui/thread-list'
import { DshRuntimeProvider } from './runtime/DshRuntime'

function App() {
  const error = useDsh((s) => s.error)
  const currentSessionId = useDsh((s) => s.currentSessionId)
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)

  useEffect(() => {
    void useDsh.getState().boot()
    connectDownlinks()
  }, [])

  useEffect(() => {
    setSidebarOpen(false)
  }, [currentSessionId])

  return (
    <div className="grid h-dvh grid-cols-1 overflow-hidden md:grid-cols-[280px_1fr]">
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close workspace sidebar"
          className="fixed inset-0 z-30 bg-black/20 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <div
        data-slot="aui_thread-list-sidebar"
        data-state={sidebarOpen ? 'open' : 'closed'}
        className={`${sidebarOpen ? 'fixed inset-y-0 start-0 z-40 flex w-[min(280px,85vw)] shadow-xl' : 'hidden'} min-h-0 flex-col overflow-hidden bg-muted/20 md:relative md:flex md:w-auto md:shadow-none`}
      >
        <ThreadList />
      </div>
      <main className="relative flex min-h-0 min-w-0 flex-col overflow-hidden">
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
        <TooltipIconButton
          tooltip="Open settings"
          type="button"
          variant="outline"
          size="icon"
          className="absolute end-3 top-3 z-20 size-8 rounded-full bg-background/90 shadow-sm"
          aria-label="Open settings"
          onClick={() => setSettingsOpen(true)}
        >
          <Settings2Icon className="size-4" />
        </TooltipIconButton>
        {error && (
          <div role="alert" className="absolute inset-x-0 top-0 z-50 border-b border-destructive/40 bg-destructive/10 px-4 py-1.5 text-destructive">
            {error}
          </div>
        )}
        <div className="flex min-h-0 flex-1 flex-col">
          <ConversationHeader />
          <div className="min-h-0 flex-1">
            <Thread />
          </div>
        </div>
        <SettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      </main>
    </div>
  )
}

export default function Root() {
  return (
    <DshRuntimeProvider>
      <App />
    </DshRuntimeProvider>
  )
}
