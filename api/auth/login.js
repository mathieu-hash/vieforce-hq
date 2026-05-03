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
const attempts = new Map()  // key: ip → { count, firstAt, lockedUntil }

function getClientIp(req) {
  // Trust X-Forwarded-For when behind Cloud Run / Vercel — they set it correctly.
  const xff = req.headers['x-forwarded-for']
  if (xff) return String(xff).split(',')[0].trim()
  return req.connection?.remoteAddress || req.socket?.remoteAddress || 'unknown'
}

function checkRateLimit(ip) {
  const now = Date.now()
  const entry = attempts.get(ip)

  // Active lockout
  if (entry?.lockedUntil && now < entry.lockedUntil) {
    return { ok: false, retryAfterSeconds: Math.ceil((entry.lockedUntil - now) / 1000) }
  }

  // First attempt or window expired → reset
  if (!entry || now - entry.firstAt > WINDOW_MS) {
    attempts.set(ip, { count: 1, firstAt: now, lockedUntil: 0 })
    return { ok: true }
  }

  // Within window — increment
  entry.count++
  if (entry.count > MAX_ATTEMPTS_PER_WINDOW) {
    entry.lockedUntil = now + LOCKOUT_MS
    return { ok: false, retryAfterSeconds: Math.ceil(LOCKOUT_MS / 1000) }
  }
  return { ok: true }
}

// Periodically clean up old entries so the Map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now()
  for (const [ip, entry] of attempts.entries()) {
    if (now - entry.firstAt > WINDOW_MS && (!entry.lockedUntil || now > entry.lockedUntil)) {
      attempts.delete(ip)
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
  const rl = checkRateLimit(ip)
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

  let supa
  try {
    supa = getSupabase()
  } catch (e) {
    console.error('[auth/login] supabase init:', e.message)
    return res.status(500).json({ ok: false, error: 'Login service unavailable' })
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
    return res.status(401).json({ ok: false, error: 'Invalid credentials' })
  }

  if (!data.is_active) {
    return res.status(403).json({ ok: false, error: 'Account is disabled' })
  }

  if (!timingSafePinCompare(data.pin_hash, pin)) {
    return res.status(401).json({ ok: false, error: 'Invalid credentials' })
  }

  // Success — return the same shape the old client-side flow built.
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
