import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_THREAD_LIST_SIDEBAR_WIDTH,
  MAX_THREAD_LIST_SIDEBAR_WIDTH,
  MIN_THREAD_LIST_SIDEBAR_WIDTH,
  THREAD_LIST_SIDEBAR_WIDTH_STORAGE_KEY,
  clampThreadListSidebarWidth,
  getThreadListSidebarMaximum,
  readThreadListSidebarWidth,
  writeThreadListSidebarWidth,
  type SidebarWidthStorage,
} from '../web/src/thread-list-sidebar-width.ts'
import { limitSize, resolveDragStartSize } from '../web/src/use-resizable-region.ts'

function createStorage(initial: string | null = null): SidebarWidthStorage & { value: string | null } {
  return {
    value: initial,
    getItem() {
      return this.value
    },
    setItem(_key, value) {
      this.value = value
    },
  }
}

test('clampThreadListSidebarWidth enforces stable pixel bounds', () => {
  assert.equal(clampThreadListSidebarWidth(319.6), 320)
  assert.equal(clampThreadListSidebarWidth(100), MIN_THREAD_LIST_SIDEBAR_WIDTH)
  assert.equal(clampThreadListSidebarWidth(900), MAX_THREAD_LIST_SIDEBAR_WIDTH)
  assert.equal(clampThreadListSidebarWidth(450, 400), 400)
})

test('getThreadListSidebarMaximum preserves room for thread content', () => {
  assert.equal(getThreadListSidebarMaximum(1200), MAX_THREAD_LIST_SIDEBAR_WIDTH)
  assert.equal(getThreadListSidebarMaximum(768), 448)
  assert.equal(getThreadListSidebarMaximum(400), MIN_THREAD_LIST_SIDEBAR_WIDTH)
})

test('resizable region helpers clamp values and prefer the rendered drag size', () => {
  assert.equal(limitSize(100, 220, 480), 220)
  assert.equal(limitSize(360, 220, 480), 360)
  assert.equal(limitSize(600, 220, 480), 480)
  assert.equal(resolveDragStartSize(334.4, 280, 220, 480), 334)
  assert.equal(resolveDragStartSize(Number.NaN, 280, 220, 480), 280)
})

test('readThreadListSidebarWidth restores and validates persisted values', () => {
  assert.equal(readThreadListSidebarWidth(createStorage('336')), 336)
  assert.equal(readThreadListSidebarWidth(createStorage('100')), MIN_THREAD_LIST_SIDEBAR_WIDTH)
  assert.equal(readThreadListSidebarWidth(createStorage('900')), MAX_THREAD_LIST_SIDEBAR_WIDTH)
  assert.equal(readThreadListSidebarWidth(createStorage('not-a-number')), DEFAULT_THREAD_LIST_SIDEBAR_WIDTH)
  assert.equal(readThreadListSidebarWidth(createStorage('')), DEFAULT_THREAD_LIST_SIDEBAR_WIDTH)
  assert.equal(readThreadListSidebarWidth(undefined), DEFAULT_THREAD_LIST_SIDEBAR_WIDTH)
})

test('storage failures do not break width reads or writes', () => {
  const throwingStorage: SidebarWidthStorage = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    },
  }

  assert.equal(readThreadListSidebarWidth(throwingStorage), DEFAULT_THREAD_LIST_SIDEBAR_WIDTH)
  assert.doesNotThrow(() => writeThreadListSidebarWidth(throwingStorage, 340))
})

test('writeThreadListSidebarWidth stores a clamped integer', () => {
  const storage = createStorage()
  writeThreadListSidebarWidth(storage, 999.8)

  assert.equal(storage.value, String(MAX_THREAD_LIST_SIDEBAR_WIDTH))
  assert.equal(THREAD_LIST_SIDEBAR_WIDTH_STORAGE_KEY, 'dsh.thread-list-sidebar.width.v1')
})
