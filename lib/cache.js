const store = new Map()

function get(key) {
  const item = store.get(key)
  if (!item) return null
  if (Date.now() > item.expiry) { store.delete(key); return null }
  return item.value
}

function set(key, value, ttlSeconds = 300) {
  store.set(key, { value, expiry: Date.now() + ttlSeconds * 1000 })
}

function clear() {
  store.clear()
}

module.exports = { get, set, clear }
