import test from 'node:test'
import assert from 'node:assert/strict'

import { followResizingContentToBottom } from '../web/src/lib/follow-resizing-content-to-bottom.ts'

class ResizeObserverStub {
  static instances: ResizeObserverStub[] = []
  observed: Element[] = []
  disconnected = 0
  private readonly callback: ResizeObserverCallback

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback
    ResizeObserverStub.instances.push(this)
  }

  observe(target: Element) {
    this.observed.push(target)
  }

  disconnect() {
    this.disconnected += 1
  }

  resize() {
    this.callback([], this as unknown as ResizeObserver)
  }
}

function createViewport() {
  const listeners = new Map<string, EventListener>()
  return {
    clientHeight: 100,
    scrollHeight: 240,
    scrollTop: 0,
    addEventListener(type: string, listener: EventListener) {
      listeners.set(type, listener)
    },
    removeEventListener(type: string) {
      listeners.delete(type)
    },
    dispatchScroll() {
      listeners.get('scroll')?.(new Event('scroll'))
    },
  }
}

interface Harness {
  frames: Array<FrameRequestCallback>
  cancelCount: number
  reset(): void
}

function installHarness(): Harness {
  const frames: Array<FrameRequestCallback> = []
  const state = { cancelCount: 0 }
  ;(globalThis as any).ResizeObserver = ResizeObserverStub
  ;(globalThis as any).requestAnimationFrame = (callback: FrameRequestCallback) => {
    frames.push(callback)
    return frames.length
  }
  ;(globalThis as any).cancelAnimationFrame = () => {
    state.cancelCount += 1
  }
  return {
    frames,
    get cancelCount() {
      return state.cancelCount
    },
    reset: () => {
      frames.length = 0
      state.cancelCount = 0
      ResizeObserverStub.instances = []
    },
  }
}

test('pins overflowing details initially and after a streaming delta', () => {
  const h = installHarness()
  h.reset()
  const viewport = createViewport()
  const content = {} as Element
  followResizingContentToBottom(viewport, content)

  const observer = ResizeObserverStub.instances[0]!
  assert.deepEqual(observer.observed, [content])
  h.frames.shift()?.(0)
  assert.equal(viewport.scrollTop, 240)

  viewport.scrollHeight = 420
  observer.resize()
  h.frames.shift()?.(1)
  assert.equal(viewport.scrollTop, 420)
})

test('keeps following when content growth fires a scroll event before the next pin', () => {
  const h = installHarness()
  h.reset()
  const viewport = createViewport()
  followResizingContentToBottom(viewport, {} as Element, { respectUserScroll: true })
  h.frames.shift()?.(0)

  viewport.scrollHeight = 420
  ResizeObserverStub.instances[0]!.resize()
  viewport.dispatchScroll()
  h.frames.shift()?.(1)

  assert.equal(viewport.scrollTop, 420)
})

test('stops following after the user scrolls up while content is stable', () => {
  const h = installHarness()
  h.reset()
  const viewport = createViewport()
  followResizingContentToBottom(viewport, {} as Element, { respectUserScroll: true })
  h.frames.shift()?.(0)

  viewport.scrollHeight = 420
  viewport.scrollTop = 320
  viewport.dispatchScroll()
  viewport.scrollTop = 220
  viewport.dispatchScroll()
  viewport.scrollHeight = 600
  ResizeObserverStub.instances[0]!.resize()
  h.frames.shift()?.(1)

  assert.equal(viewport.scrollTop, 220)
})

test('does not scroll non-overflowing details and cleans up pending work', () => {
  const h = installHarness()
  h.reset()
  const viewport = { clientHeight: 100, scrollHeight: 80, scrollTop: 0 }
  const stop = followResizingContentToBottom(viewport as never, {} as Element)

  h.frames.shift()?.(0)
  assert.equal(viewport.scrollTop, 0)

  ResizeObserverStub.instances[0]!.resize()
  stop()
  assert.equal(ResizeObserverStub.instances[0]!.disconnected, 1)
  assert.equal(h.cancelCount, 1)
})
