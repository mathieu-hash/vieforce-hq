// Simple in-memory TTL cache for the long-lived Cloud Run Express process.
// Bounded in size and periodically swept so it cannot grow without limit
// (each dashboard payload can be hundreds of KB; without a cap the process
// would OOM after days of uptime).

const store = new Map()

// Safety cap. Well above the realistic distinct-key count (a few hundred:
// endpoints × periods × regions × segments × users) but low enough that a
// pathological key explosion can't exhaust memory.
const MAX_ENTRIES = 2000

function get(key) {
  const item = store.get(key)
  if (!item) return null
  if (Date.now() > item.expiry) { store.delete(key); return null }
  return item.value
}

function set(key, value, ttlSeconds = 300) {
  // Evict the oldest entry when at capacity (Map preserves insertion order).
  if (!store.has(key) && store.size >= MAX_ENTRIES) {
    const oldest = store.keys().next().value
    if (oldest !== undefined) store.delete(oldest)
  }
  store.set(key, { value, expiry: Date.now() + ttlSeconds * 1000 })
}

function clear() {
  store.clear()
}

// Drop expired entries even if their key is never read again. Without this,
// entries built from one-off keys (e.g. per-search-term) linger until eviction.
function sweep(now = Date.now()) {
  let removed = 0
  for (const [key, item] of store.entries()) {
    if (now > item.expiry) { store.delete(key); removed++ }
  }
  return removed
}

// Normalize a request URL for use in a cache key: strips the client's `_t`
// cache-buster (js/api.js appends `_t=Date.now()` to every call) so that
// otherwise-identical requests share a cache entry instead of missing 100%
// of the time. Also drops any leading `?` and sorts params for stability.
function keyableUrl(url) {
  if (!url) return ''
  const qIdx = url.indexOf('?')
  if (qIdx === -1) return url
  const base = url.slice(0, qIdx)
  const params = new URLSearchParams(url.slice(qIdx + 1))
  params.delete('_t')
  const pairs = [...params.entries()].sort(([a], [b]) => a.localeCompare(b))
  const qs = pairs.map(([k, v]) => `${k}=${v}`).join('&')
  return qs ? `${base}?${qs}` : base
}

// Sweep every 5 minutes. unref() so the timer never keeps the process alive.
const _sweepTimer = setInterval(() => sweep(), 5 * 60 * 1000)
if (_sweepTimer.unref) _sweepTimer.unref()

module.exports = { get, set, clear, sweep, keyableUrl, MAX_ENTRIES }
