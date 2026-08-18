import { useEffect, useRef, useState } from 'react'
import {
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
  useParams,
} from '@tanstack/react-router'
import App from './App'
import { ConversationHeader } from './components/conversation-header'
import { ThreadRoot } from './components/assistant-ui/thread'
import { useDsh } from './dsh/store'

function RouteLoading() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
      Loading thread...
    </div>
  )
}

function ConversationSurface({
  threadId,
  hydrated,
}: {
  threadId?: string
  hydrated?: boolean
}) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <ConversationHeader />
      <div className="min-h-0 flex-1">
        <ThreadRoot key={threadId ?? 'empty'} sessionId={threadId} hydrated={hydrated} />
      </div>
    </div>
  )
}

function HomeRoute() {
  const booting = useDsh((state) => state.booting)
  const currentSessionId = useDsh((state) => state.currentSessionId)
  const sessionExists = useDsh((state) => currentSessionId !== null && state.sessions.some((session) => session.sessionId === currentSessionId))
  const navigate = useNavigate()

  useEffect(() => {
    if (booting || currentSessionId === null || !sessionExists) return
    void navigate({
      to: '/thread/$threadId',
      params: { threadId: currentSessionId },
      replace: true,
    })
  }, [booting, currentSessionId, navigate, sessionExists])

  if (booting) return <RouteLoading />
  if (currentSessionId !== null && !sessionExists) return <RouteLoading />
  return <ConversationSurface threadId={currentSessionId ?? undefined} />
}

function ThreadRoute() {
  const { threadId } = useParams({ from: '/thread/$threadId' })
  const booting = useDsh((state) => state.booting)
  const session = useDsh((state) => state.sessions.find((item) => item.sessionId === threadId))
  const currentSessionId = useDsh((state) => state.currentSessionId)
  const loadingHistory = useDsh((state) => state.loadingHistory)
  const error = useDsh((state) => state.error)
  const openSession = useDsh((state) => state.openSession)
  const navigate = useNavigate()
  const requestedThreadId = useRef<string | null>(null)
  const [hydratedThreadId, setHydratedThreadId] = useState<string | null>(null)

  useEffect(() => {
    let frame = 0
    if (booting) return
    if (session === undefined) {
      void navigate({ to: '/', replace: true })
      return
    }

    if (requestedThreadId.current !== threadId) {
      requestedThreadId.current = threadId
      setHydratedThreadId(null)
      const state = useDsh.getState()
      if (state.currentSessionId !== threadId) void openSession(threadId)
    }

    const state = useDsh.getState()
    if (state.currentSessionId === threadId && !state.loadingHistory && state.error === null) {
      // The external assistant-ui runtime projects the store messages on the
      // following frame. Do not expose an empty buffer as a new chat first.
      frame = window.requestAnimationFrame(() => {
        const latest = useDsh.getState()
        if (latest.currentSessionId === threadId && !latest.loadingHistory && latest.error === null) {
          setHydratedThreadId(threadId)
        }
      })
    }

    return () => window.cancelAnimationFrame(frame)
  }, [booting, currentSessionId, error, loadingHistory, navigate, openSession, session, threadId])

  if (booting || session === undefined) return <RouteLoading />
  return <ConversationSurface threadId={threadId} hydrated={hydratedThreadId === threadId} />
}

const rootRoute = createRootRoute({ component: App })

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  component: HomeRoute,
})

const threadRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/thread/$threadId',
  component: ThreadRoute,
})

const routeTree = rootRoute.addChildren([indexRoute, threadRoute])

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
})

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router
  }
}
