export const THREAD_LIST_SIDEBAR_WIDTH_STORAGE_KEY = 'dsh.thread-list-sidebar.width.v1'
export const DEFAULT_THREAD_LIST_SIDEBAR_WIDTH = 280
export const MIN_THREAD_LIST_SIDEBAR_WIDTH = 220
export const MAX_THREAD_LIST_SIDEBAR_WIDTH = 480
export const MIN_THREAD_CONTENT_WIDTH = 320

export type SidebarWidthStorage = Pick<Storage, 'getItem' | 'setItem'>

export function clampThreadListSidebarWidth(
  width: number,
  maximum = MAX_THREAD_LIST_SIDEBAR_WIDTH,
): number {
  const safeMaximum = Math.max(
    MIN_THREAD_LIST_SIDEBAR_WIDTH,
    Math.min(MAX_THREAD_LIST_SIDEBAR_WIDTH, maximum),
  )

  return Math.round(Math.min(safeMaximum, Math.max(MIN_THREAD_LIST_SIDEBAR_WIDTH, width)))
}

export function getThreadListSidebarMaximum(viewportWidth: number): number {
  return clampThreadListSidebarWidth(
    MAX_THREAD_LIST_SIDEBAR_WIDTH,
    viewportWidth - MIN_THREAD_CONTENT_WIDTH,
  )
}

export function readThreadListSidebarWidth(storage?: SidebarWidthStorage): number {
  if (!storage) return DEFAULT_THREAD_LIST_SIDEBAR_WIDTH

  try {
    const stored = storage.getItem(THREAD_LIST_SIDEBAR_WIDTH_STORAGE_KEY)
    if (stored === null || stored.trim() === '') return DEFAULT_THREAD_LIST_SIDEBAR_WIDTH

    const width = Number(stored)
    if (!Number.isFinite(width)) return DEFAULT_THREAD_LIST_SIDEBAR_WIDTH
    return clampThreadListSidebarWidth(width)
  } catch {
    return DEFAULT_THREAD_LIST_SIDEBAR_WIDTH
  }
}

export function writeThreadListSidebarWidth(
  storage: SidebarWidthStorage | undefined,
  width: number,
): void {
  if (!storage) return

  try {
    storage.setItem(
      THREAD_LIST_SIDEBAR_WIDTH_STORAGE_KEY,
      String(clampThreadListSidebarWidth(width)),
    )
  } catch {
    // View persistence is best effort.
  }
}
