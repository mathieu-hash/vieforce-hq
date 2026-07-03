const { test } = require('node:test')
const assert = require('node:assert/strict')
const { __test } = require('../api/auth/login')
const { getClientIp, peekLimit, recordFailure, timingSafePinCompare } = __test

test('getClientIp is not spoofable by a prepended X-Forwarded-For (default 1 hop)', () => {
  delete process.env.TRUSTED_PROXY_HOPS
  // Attacker prepends a random value; the platform appends the real client IP last.
  const ip = getClientIp({ headers: { 'x-forwarded-for': 'ATTACKER-SPOOF, 203.0.113.9' } })
  assert.equal(ip, '203.0.113.9', 'must take the platform-appended rightmost hop, not the client-supplied first')
})

test('getClientIp respects TRUSTED_PROXY_HOPS for deeper proxy chains', () => {
  process.env.TRUSTED_PROXY_HOPS = '2'
  const ip = getClientIp({ headers: { 'x-forwarded-for': 'spoof, 203.0.113.9, 10.0.0.1' } })
  assert.equal(ip, '203.0.113.9', 'with 2 hops, client IP is 2nd from the end')
  delete process.env.TRUSTED_PROXY_HOPS
})

test('getClientIp falls back to socket address when no XFF', () => {
  const ip = getClientIp({ headers: {}, socket: { remoteAddress: '198.51.100.7' } })
  assert.equal(ip, '198.51.100.7')
})

test('peekLimit does not count attempts — only recordFailure locks out', () => {
  const map = new Map()
  const key = 'k'
  // Peeking many times must never lock (successful logins must not accumulate).
  for (let i = 0; i < 20; i++) {
    assert.equal(peekLimit(map, key).ok, true, `peek ${i + 1} still allowed`)
  }
})

test('recordFailure locks out after maxAttempts failures within the window', () => {
  const map = new Map()
  const key = 'k'
  // maxAttempts=3: 3 failures → locked on the 3rd.
  recordFailure(map, key, 3, 60000, 60000)
  assert.equal(peekLimit(map, key).ok, true, 'after 1 failure still allowed')
  recordFailure(map, key, 3, 60000, 60000)
  assert.equal(peekLimit(map, key).ok, true, 'after 2 failures still allowed')
  recordFailure(map, key, 3, 60000, 60000)
  const blocked = peekLimit(map, key)
  assert.equal(blocked.ok, false, 'after 3 failures locked')
  assert.ok(blocked.retryAfterSeconds > 0)
})

test('recordFailure for one key does not affect another (per-account isolation)', () => {
  const map = new Map()
  for (let i = 0; i < 5; i++) recordFailure(map, 'phoneA', 3, 60000, 60000)
  assert.equal(peekLimit(map, 'phoneA').ok, false, 'phoneA locked')
  assert.equal(peekLimit(map, 'phoneB').ok, true, 'phoneB unaffected')
})

test('timingSafePinCompare returns true only on exact match', () => {
  assert.equal(timingSafePinCompare('1234', '1234'), true)
  assert.equal(timingSafePinCompare('1234', '1235'), false)
  assert.equal(timingSafePinCompare('1234', '12345'), false) // different length
})
