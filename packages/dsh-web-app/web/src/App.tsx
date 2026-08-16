import { useEffect } from 'react'
import { useDsh } from './dsh/store'
import { connectDownlinks } from './dsh/stream'
import { Thread } from './components/assistant-ui/thread'
import { ThreadList } from './components/assistant-ui/thread-list'
import { DshRuntimeProvider } from './runtime/DshRuntime'

function App() {
  const error = useDsh((s) => s.error)

  useEffect(() => {
    void useDsh.getState().boot()
    connectDownlinks()
  }, [])

  return (
    <div className="grid h-dvh grid-cols-[280px_1fr] overflow-hidden">
      <div className="min-h-0 overflow-hidden">
        <ThreadList />
      </div>
      <main className="relative min-h-0 min-w-0 overflow-hidden">
        {error && (
          <div className="absolute inset-x-0 top-0 z-50 border-b border-destructive/40 bg-destructive/10 px-4 py-1.5 text-sm text-destructive">
            {error}
          </div>
        )}
        <Thread />
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
