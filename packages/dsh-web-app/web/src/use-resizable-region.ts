import {
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
} from 'react'

interface ResizableRegionOptions {
  value: number
  min: number
  getMaxSize(): number
  direction: 1 | -1
  onCommit(value: number): void
}

interface ResizableRegionBinding<T extends HTMLElement> {
  regionRef: RefObject<T | null>
  separatorRef: RefObject<HTMLDivElement | null>
  initialSize: number
  initialMax: number
  commitSize(value: number): void
  onPointerDown(event: ReactPointerEvent<HTMLDivElement>): void
  onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>): void
}

const REGION_SIZE_PROPERTY = '--resizable-region-size'

/** Apply transient drag sizes through a CSS variable without rendering React. */
export function useResizableRegion<T extends HTMLElement>(
  options: ResizableRegionOptions,
): ResizableRegionBinding<T> {
  const optionsRef = useRef(options)
  const regionRef = useRef<T>(null)
  const separatorRef = useRef<HTMLDivElement>(null)
  const currentSizeRef = useRef(limitSize(options.value, options.min, options.getMaxSize()))
  const pendingSizeRef = useRef(currentSizeRef.current)
  const frameRef = useRef<number | null>(null)
  const cleanupPointerRef = useRef<(() => void) | null>(null)
  optionsRef.current = options

  const applySize = useCallback((requestedSize: number) => {
    const currentOptions = optionsRef.current
    const max = currentOptions.getMaxSize()
    const size = limitSize(requestedSize, currentOptions.min, max)
    currentSizeRef.current = size
    pendingSizeRef.current = size
    regionRef.current?.style.setProperty(REGION_SIZE_PROPERTY, `${size}px`)
    separatorRef.current?.setAttribute('aria-valuemax', String(Math.round(Math.max(currentOptions.min, max))))
    separatorRef.current?.setAttribute('aria-valuenow', String(size))
    separatorRef.current?.setAttribute('aria-valuetext', `${size} pixels`)
    return size
  }, [])

  const scheduleSize = useCallback((requestedSize: number) => {
    pendingSizeRef.current = requestedSize
    if (frameRef.current !== null) return
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null
      applySize(pendingSizeRef.current)
    })
  }, [applySize])

  const flushPendingSize = useCallback(() => {
    if (frameRef.current === null) return currentSizeRef.current
    cancelAnimationFrame(frameRef.current)
    frameRef.current = null
    return applySize(pendingSizeRef.current)
  }, [applySize])

  const commitSize = useCallback((requestedSize: number) => {
    const size = applySize(requestedSize)
    optionsRef.current.onCommit(size)
  }, [applySize])

  useLayoutEffect(() => {
    applySize(options.value)
  }, [applySize, options.value])

  useEffect(() => {
    const clampToViewport = () => applySize(optionsRef.current.value)
    window.addEventListener('resize', clampToViewport)
    return () => window.removeEventListener('resize', clampToViewport)
  }, [applySize])

  useEffect(() => () => {
    cleanupPointerRef.current?.()
    if (frameRef.current !== null) cancelAnimationFrame(frameRef.current)
  }, [])

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return
    event.preventDefault()
    cleanupPointerRef.current?.()
    const currentOptions = optionsRef.current
    const renderedSize = regionRef.current?.getBoundingClientRect().width ?? Number.NaN
    const startSize = resolveDragStartSize(
      renderedSize,
      currentSizeRef.current,
      currentOptions.min,
      currentOptions.getMaxSize(),
    )
    const startPoint = event.clientX
    const separator = event.currentTarget
    const pointerId = event.pointerId
    const move = (nextEvent: PointerEvent) => {
      scheduleSize(startSize + (nextEvent.clientX - startPoint) * currentOptions.direction)
    }
    const cleanup = () => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', stop)
      window.removeEventListener('pointercancel', stop)
      if (separator.hasPointerCapture(pointerId)) separator.releasePointerCapture(pointerId)
      cleanupPointerRef.current = null
      document.body.classList.remove('is-resizing-column')
    }
    const stop = () => {
      cleanupPointerRef.current?.()
      optionsRef.current.onCommit(flushPendingSize())
    }

    cleanupPointerRef.current = cleanup
    separator.setPointerCapture(pointerId)
    document.body.classList.add('is-resizing-column')
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop, { once: true })
    window.addEventListener('pointercancel', stop, { once: true })
  }, [flushPendingSize, scheduleSize])

  const onKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
    const currentOptions = optionsRef.current
    const backward = event.key === 'ArrowLeft'
    const forward = event.key === 'ArrowRight'
    if (!backward && !forward && event.key !== 'Home' && event.key !== 'End') return
    event.preventDefault()
    const step = event.shiftKey ? 48 : 16
    const next = event.key === 'Home'
      ? currentOptions.min
      : event.key === 'End'
        ? currentOptions.getMaxSize()
        : currentSizeRef.current + (backward ? -step : step) * currentOptions.direction
    commitSize(next)
  }, [commitSize])

  const initialMax = Math.max(options.min, options.getMaxSize())
  return {
    regionRef,
    separatorRef,
    initialSize: limitSize(options.value, options.min, initialMax),
    initialMax: Math.round(initialMax),
    commitSize,
    onPointerDown,
    onKeyDown,
  }
}

export function limitSize(value: number, min: number, max: number): number {
  return Math.round(Math.min(Math.max(value, min), Math.max(min, max)))
}

export function resolveDragStartSize(
  renderedSize: number,
  fallback: number,
  min: number,
  max: number,
): number {
  return Number.isFinite(renderedSize) && renderedSize > 0
    ? limitSize(renderedSize, min, max)
    : fallback
}
