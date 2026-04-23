// Shared helpers for /api/admin/* endpoints.
//
// - requireAdmin(req, res): resolves session via service-token OR user session,
//   then enforces role ∈ ('service','exec','ceo'). Returns the session on
//   success; calls res.status(...).json(...) and returns null on failure so
//   the caller can early-return with a terse `if (!session) return`.
//
// - getAdminSupabase(): returns a Supabase client authenticated with the
//   SERVICE_ROLE key (required to call auth.admin.* and to bypass RLS on
//   public.users). Throws if the env var is missing; the endpoint handlers
//   translate that into a 503 so ops sees a clear "not configured" signal
//   instead of a generic 500.
//
// - provisionalPhone(slpCode): '09180000' + 3-digit zero-padded SlpCode.
//
// - setCors(res): the CORS headers used by every admin endpoint. express
//   `cors()` in server.js already handles preflight; these are defense-in-depth
//   so the response envelope looks the same as the rest of /api/*.

const { createClient } = require('@supabase/supabase-js')
const { verifySession, verifyServiceToken } = require('../_auth')

const ALLOWED_ROLES = new Set(['service', 'exec', 'ceo'])

async function requireAdmin(req, res) {
  const session = await verifyServiceToken(req) || await verifySession(req)
  if (!session) {
    res.status(401).json({ error: 'Unauthorized' })
    return null
  }
  if (!ALLOWED_ROLES.has(session.role)) {
    res.status(403).json({ error: 'Admin access required' })
    return null
  }
  return session
}

let _adminClient = null
function getAdminSupabase() {
  if (_adminClient) return _adminClient
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) {
    const missing = !url ? 'SUPABASE_URL' : 'SUPABASE_SERVICE_ROLE_KEY'
    const err = new Error(`Admin portal not configured — ${missing} missing`)
    err.code = 'ADMIN_NOT_CONFIGURED'
    throw err
  }
  _adminClient = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return _adminClient
}

function provisionalPhone(slpCode) {
  const n = Number(slpCode)
  if (!Number.isInteger(n) || n <= 0 || n > 999) {
    throw new Error(`provisionalPhone: invalid slp_code ${slpCode}`)
  }
  return '09180000' + String(n).padStart(3, '0')
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, authorization, content-type')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS')
}

function adminConfigError(res, err) {
  if (err && err.code === 'ADMIN_NOT_CONFIGURED') {
    console.error('[admin]', err.message)
    res.status(503).json({ error: 'Admin portal not configured', detail: err.message })
    return true
  }
  return false
}

module.exports = {
  requireAdmin,
  getAdminSupabase,
  provisionalPhone,
  setCors,
  adminConfigError
}
