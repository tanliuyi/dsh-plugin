import test from 'node:test'
import assert from 'node:assert/strict'

import { threadIdFromPathname } from '../web/src/router-navigation.ts'

test('threadIdFromPathname parses browser-history thread URLs', () => {
  assert.equal(threadIdFromPathname('/thread/session-123'), 'session-123')
  assert.equal(threadIdFromPathname('/thread/session-123/'), 'session-123')
  assert.equal(threadIdFromPathname('/thread/session%2Fchild'), 'session/child')
})

test('threadIdFromPathname ignores non-thread and malformed URLs', () => {
  assert.equal(threadIdFromPathname('/'), null)
  assert.equal(threadIdFromPathname('/settings'), null)
  assert.equal(threadIdFromPathname('/thread/'), null)
  assert.equal(threadIdFromPathname('/thread/%E0%A4%A'), null)
})
