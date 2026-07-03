const { test } = require('node:test')
const assert = require('node:assert/strict')
const cache = require('../lib/cache')

test('keyableUrl strips the _t cache-buster so identical requests share a key', () => {
  const a = cache.keyableUrl('/api/ar?region=Luzon&segment=DIST&_t=1699999999999')
  const b = cache.keyableUrl('/api/ar?region=Luzon&segment=DIST&_t=1700000000000')
  assert.equal(a, b)
  assert.ok(!a.includes('_t='), 'key must not contain the volatile _t param')
})

test('keyableUrl sorts params so order does not fork the key', () => {
  const a = cache.keyableUrl('/api/ar?region=Luzon&segment=DIST')
  const b = cache.keyableUrl('/api/ar?segment=DIST&region=Luzon')
  assert.equal(a, b)
})

test('keyableUrl preserves distinguishing params', () => {
  const a = cache.keyableUrl('/api/ar?region=Luzon&_t=1')
  const b = cache.keyableUrl('/api/ar?region=Visayas&_t=2')
  assert.notEqual(a, b)
})

test('keyableUrl handles urls with no query string', () => {
  assert.equal(cache.keyableUrl('/api/inventory'), '/api/inventory')
  assert.equal(cache.keyableUrl(''), '')
})

test('get returns null after ttl expiry', () => {
  cache.clear()
  cache.set('k', 'v', 0.001) // ~1ms ttl
  const now = Date.now()
  while (Date.now() <= now + 2) { /* spin ~2ms */ }
  assert.equal(cache.get('k'), null)
})

test('cache is bounded — oldest entry is evicted at capacity', () => {
  cache.clear()
  const N = cache.MAX_ENTRIES
  for (let i = 0; i < N; i++) cache.set('key_' + i, i, 300)
  assert.equal(cache.get('key_0'), 0, 'first key present before overflow')
  cache.set('overflow', 'x', 300) // one past capacity
  assert.equal(cache.get('key_0'), null, 'oldest key evicted')
  assert.equal(cache.get('overflow'), 'x', 'new key retained')
  cache.clear()
})

test('sweep removes expired entries even if never read again', () => {
  cache.clear()
  cache.set('live', 'a', 300)
  cache.set('dead', 'b', 0.001)
  const now = Date.now()
  while (Date.now() <= now + 2) { /* spin ~2ms */ }
  const removed = cache.sweep()
  assert.ok(removed >= 1, 'at least the expired entry swept')
  assert.equal(cache.get('live'), 'a')
  cache.clear()
})
