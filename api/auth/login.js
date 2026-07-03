// POST /api/auth/login
// Server-side PIN verification — replaces the client-side Supabase users table read.
//
// Why this exists:
//   The previous flow had js/auth.js call Supabase directly with the anon key, reading
//   `pin_hash` plaintext into the browser. Anyone with the public anon key + a phone
//   number could SELECT all PINs. This endpoint moves the comparison server-side so the
//   anon role can be locked OUT of public.users entirely (see migrations/lock-users-rls.sql).
//
// Security features:
//   - PIN never crosses the network plaintext after this endpoint (and never leaves the server)
//   - Service-role Supabase client (bypasses RLS so the locked-down policy still permits us)
//   - Per-IP rate limit: 5 attempts per minute, 30 lockout on exceed
//   - Constant-time PIN comparison to defeat timing attacks
//   - No detailed errors that distinguish "invalid phone" from "wrong PIN" (defeats enumeration)
//
// Body: { phone: '09XXXXXXXXX', pin: '1234' }
// Returns:
//   200 { ok: true, user: { id, name, role, region, district, territory, expiresAt } }
//   400 { ok: false, error: 'Missing phone or PIN' }
//   401 { ok: false, error: 'Invalid credentials' }                     (generic — phone OR pin wrong)
//   403 { ok: false, error: 'Account is disabled' }
//   429 { ok: false, error: 'Too many attempts', retryAfterSeconds: 30 }
//   500 { ok: false, error: 'Login service unavailable' }
//
// Note: this endpoint does NOT issue a JWT. It returns the same user shape the previous
// client-side flow stored in localStorage, so js/auth.js can drop in with minimal change.
// A proper JWT/refresh-token flow is the next iteration.

const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

const SESSION_TTL_MS = 24 * 60 * 60 * 1000   // 24 hours, matches existing client TTL
const MAX_ATTEMPTS_PER_WINDOW = 5
const WINDOW_MS = 60 * 1000                  // 1 minute
const LOCKOUT_MS = 30 * 1000                 // 30 seconds after exceed

// In-memory rate-limit store. Per Cloud Run instance — not perfect for multi-instance
// horizontal scaling, but for an internal dashboard with low concurrency this is adequate.
// For stricter guarantees move to Upstash Redis or Cloud Memorystore.
const attempts = new Map()       // key: ip    → { count, firstAt, lockedUntil }
const phoneAttempts = new Map()  // key: phone → { count, firstAt, lockedUntil }

// Per-phone limit: an attacker who rotates IPs (see getClientIp) can defeat the
// per-IP limit, but they cannot rotate the target phone number. This caps total
// guesses against any single account regardless of source IP.
const PHONE_MAX_ATTEMPTS = 10
const PHONE_WINDOW_MS = 15 * 60 * 1000   // 15 minutes
const PHONE_LOCKOUT_MS = 15 * 60 * 1000  // 15 minutes

function getClientIp(req) {
  // X-Forwarded-For is a CLIENT-CONTROLLABLE header; a caller can prepend an
  // arbitrary value to rotate the rate-limit key on every request. Cloud Run /
  // the load balancer APPEND the real peer to the RIGHT, so we count hops from
  // the end. TRUSTED_PROXY_HOPS = number of proxies between the app and the
  // client (default 1 = Cloud Run appends the client IP as the last entry).
  const xff = req.headers['x-forwarded-for']
  if (xff) {
    const parts = String(xff).split(',').map(s => s.trim()).filter(Boolean)
    if (parts.length) {
      const hops = parseInt(process.env.TRUSTED_PROXY_HOPS || '1') || 1
      const idx = Math.max(0, parts.length - hops)
      return parts[idx]
    }
  }
  return req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown'
}

// Sliding-window limiter that counts FAILURES ONLY. Successful logins never
// increment the counter and clear it on the way out (see the handler). This is
// deliberate: ~40 users share one office NAT (one public IP), so counting every
// attempt — including successes — would let a normal morning login surge lock
// everyone out. Per-account (phone) counting is the real brute-force guard.

// Read-only check — does NOT increment. Reject if currently locked.
function peekLimit(map, key) {
  const entry = map.get(key)
  const now = Date.now()
  if (entry?.lockedUntil && now < entry.lockedUntil) {
    return { ok: false, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) }
  }
  return { ok: true }
}

// Record one failed attempt; lock the key once it reaches maxAttempts in-window.
function recordFailure(map, key, maxAttempts, windowMs, lockoutMs) {
  const now = Date.now()
  const entry = map.get(key)
  if (!entry || now - entry.firstAt > windowMs) {
    map.set(key, { count: 1, firstAt: now, lockedUntil: 0 })
    return
  }
  entry.count++
  if (entry.count >= maxAttempts) {
    entry.lockedUntil = now + lockoutMs
  }
}

// Clear both buckets on successful auth so a legitimate login wipes any prior
// failures (and never contributes to a shared-IP lockout).
function clearAttempts(ip, phone) {
  attempts.delete(ip)
  if (phone) phoneAttempts.delete(phone)
}

// Record a failed login against BOTH the IP and the phone buckets.
function recordFailedAttempt(ip, phone) {
  recordFailure(attempts, ip, MAX_ATTEMPTS_PER_WINDOW, WINDOW_MS, LOCKOUT_MS)
  if (phone) recordFailure(phoneAttempts, phone, PHONE_MAX_ATTEMPTS, PHONE_WINDOW_MS, PHONE_LOCKOUT_MS)
}

// Periodically clean up old entries so the Maps don't grow unbounded.
setInterval(() => {
  const now = Date.now()
  for (const map of [attempts, phoneAttempts]) {
    for (const [key, entry] of map.entries()) {
      const windowPast = now - entry.firstAt > PHONE_WINDOW_MS
      const notLocked = !entry.lockedUntil || now > entry.lockedUntil
      if (windowPast && notLocked) map.delete(key)
    }
  }
}, 60 * 1000).unref?.()

let _supa = null
function getSupabase() {
  if (_supa) return _supa
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set')
  _supa = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return _supa
}

function timingSafePinCompare(a, b) {
  // Both args must be strings. Pad to equal length so timingSafeEqual doesn't throw.
  const aBuf = Buffer.from(String(a), 'utf8')
  const bBuf = Buffer.from(String(b), 'utf8')
  if (aBuf.length !== bBuf.length) {
    // Still do a comparison to keep timing similar — discard result.
    crypto.timingSafeEqual(Buffer.alloc(8), Buffer.alloc(8))
    return false
  }
  return crypto.timingSafeEqual(aBuf, bBuf)
}

module.exports = async (req, res) => {
  // CORS handled by server.js cors() middleware
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })

  const ip = getClientIp(req)
  // Read-only lockout check (does not count this attempt). Only FAILED logins
  // increment; successes clear the counters below.
  const rl = peekLimit(attempts, ip)
  if (!rl.ok) {
    res.setHeader('Retry-After', String(rl.retryAfterSeconds))
    return res.status(429).json({ ok: false, error: 'Too many attempts', retryAfterSeconds: rl.retryAfterSeconds })
  }

  const body = req.body || {}
  const phoneRaw = typeof body.phone === 'string' ? body.phone : ''
  const pin = typeof body.pin === 'string' ? body.pin : ''
  const phone = phoneRaw.replace(/\D/g, '')

  if (!phone || !pin) {
    return res.status(400).json({ ok: false, error: 'Missing phone or PIN' })
  }

  // Normalize PH local format — keep 09xx (matches public.users.phone storage)
  const normalized = phone.startsWith('63') && phone.length > 11
    ? '0' + phone.slice(2)
    : phone

  // Per-account lockout — caps total FAILED guesses against this phone across all
  // IPs (read-only check; recordFailedAttempt below does the counting).
  const pl = peekLimit(phoneAttempts, normalized)
  if (!pl.ok) {
    res.setHeader('Retry-After', String(pl.retryAfterSeconds))
    return res.status(429).json({ ok: false, error: 'Too many attempts', retryAfterSeconds: pl.retryAfterSeconds })
  }

  let supa
  try {
    supa = getSupabase()
  } catch (e) {
    console.error('[auth/login] supabase init:', e.message)
    const devHint =
      e.message && e.message.includes('SUPABASE_SERVICE_ROLE_KEY')
        ? 'Local dev: add SUPABASE_SERVICE_ROLE_KEY to .env.local, then restart node server.js.'
        : null
    return res.status(500).json({
      ok: false,
      error: devHint || 'Login service unavailable'
    })
  }

  const { data, error } = await supa
    .from('users')
    .select('id, name, role, region, district, territory, pin_hash, is_active')
    .eq('phone', normalized)
    .maybeSingle()

  if (error) {
    console.error('[auth/login] db error:', error.message)
    return res.status(500).json({ ok: false, error: 'Login service unavailable' })
  }

  // Generic 401 for both "no such phone" and "wrong PIN" to defeat enumeration.
  if (!data) {
    // Run a constant-time compare anyway to keep timing similar.
    timingSafePinCompare(pin, '0000')
    recordFailedAttempt(ip, normalized)
    return res.status(401).json({ ok: false, error: 'Invalid credentials' })
  }

  if (!data.is_active) {
    return res.status(403).json({ ok: false, error: 'Account is disabled' })
  }

  if (!timingSafePinCompare(data.pin_hash, pin)) {
    recordFailedAttempt(ip, normalized)
    return res.status(401).json({ ok: false, error: 'Invalid credentials' })
  }

  // Success — clear any prior failed-attempt counters for this IP + phone so a
  // legitimate login can never contribute to a shared-office-NAT lockout.
  clearAttempts(ip, normalized)

  // Return the same shape the old client-side flow built.
  const now = Date.now()
  return res.json({
    ok: true,
    user: {
      id: data.id,
      name: data.name,
      role: data.role,
      region: data.region || null,
      district: data.district || null,
      territory: data.territory || null,
      loggedInAt: now,
      expiresAt: now + SESSION_TTL_MS
    }
  })
}

// Test-only surface for the rate-limit internals (the default export stays the
// handler). Not used at runtime.
module.exports.__test = { getClientIp, peekLimit, recordFailure, timingSafePinCompare }
