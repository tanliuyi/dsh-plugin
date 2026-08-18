import { useCallback } from 'react'
import { useNavigate } from '@tanstack/react-router'

/** Extract the session id from the browser-history thread route. */
export function threadIdFromPathname(pathname: string): string | null {
  const match = /^\/thread\/([^/]+)\/?$/.exec(pathname)
  if (!match) return null
  try {
    return decodeURIComponent(match[1]!)
  } catch {
    return null
  }
}

/** Navigate to one session without coupling UI components to the router instance. */
export function useThreadNavigation(): (threadId: string, replace?: boolean) => Promise<void> {
  const navigate = useNavigate()
  return useCallback((threadId: string, replace = false) => navigate({
    to: '/thread/$threadId',
    params: { threadId },
    replace,
  }), [navigate])
}
