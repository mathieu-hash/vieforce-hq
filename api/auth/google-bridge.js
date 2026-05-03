// POST /api/auth/google-bridge
// After Supabase Google OAuth, the browser holds a user JWT. This endpoint
// validates it with the project service role, checks @vienovo.ph + HQ role,
// and returns the same session shape as POST /api/auth/login (vf_session).
//
// Body: { access_token: string }  (Supabase session.access_token)
// Header alternative: Authorization: Bearer <access_token>
//
// Why server-side: public.users RLS blocks anon reads; Patrol can still read
// managers client-side if their policies differ — HQ standardizes on service role.

const { createClient } = require('@supabase/supabase-js')

const SESSION_TTL_MS = 24 * 60 * 60 * 1000
const GOOGLE_ALLOWED_DOMAIN = 'vienovo.ph'
// Manager-style roles allowed to use Google on HQ (TSR / champion use phone+PIN).
const HQ_GOOGLE_ROLES = new Set([
  'dsm', 'rsm', 'director', 'exec', 'admin', 'ceo', 'evp', 'marketing'
])

let _supa = null
function getSupabase() {
  if (_supa) return _supa
  const url = process.env.SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set')
  _supa = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  return _supa
}

function normalizeEmail(raw) {
  if (!raw) return ''
  return String(raw).trim().toLowerCase()
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ ok: false, error: 'Method not allowed' })

  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : ''
  const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : ''
  const body = req.body || {}
  const fromBody = typeof body.access_token === 'string' ? body.access_token.trim() : ''
  const accessToken = bearer || fromBody

  if (!accessToken) {
    return res.status(400).json({ ok: false, error: 'Missing access_token' })
  }

  let supa
  try {
    supa = getSupabase()
  } catch (e) {
    console.error('[auth/google-bridge] supabase init:', e.message)
    return res.status(500).json({ ok: false, error: 'Login service unavailable' })
  }

  const { data: authData, error: authErr } = await supa.auth.getUser(accessToken)
  if (authErr || !authData || !authData.user) {
    return res.status(401).json({ ok: false, error: 'Invalid or expired Google session' })
  }

  const email = normalizeEmail(authData.user.email)
  if (!email || !email.endsWith('@' + GOOGLE_ALLOWED_DOMAIN)) {
    return res.status(403).json({
      ok: false,
      error: 'Only @' + GOOGLE_ALLOWED_DOMAIN + ' Google accounts are allowed.'
    })
  }

  const { data: row, error: dbErr } = await supa
    .from('users')
    .select('id, name, role, region, district, territory, is_active, email')
    .eq('email', email)
    .maybeSingle()

  if (dbErr) {
    console.error('[auth/google-bridge] db:', dbErr.message)
    return res.status(500).json({ ok: false, error: 'Login service unavailable' })
  }

  if (!row) {
    return res.status(403).json({
      ok: false,
      error: 'Google account not linked in VieForce. Ask admin to add your email to your user profile.'
    })
  }

  if (!row.is_active) {
    return res.status(403).json({ ok: false, error: 'Account is disabled' })
  }

  const role = String(row.role || '').toLowerCase()
  if (!HQ_GOOGLE_ROLES.has(role)) {
    return res.status(403).json({
      ok: false,
      error: 'Google sign-in is for manager and HQ staff roles. Use phone + PIN for field login.'
    })
  }

  const now = Date.now()
  return res.json({
    ok: true,
    user: {
      id: row.id,
      name: row.name,
      role: row.role,
      region: row.region || null,
      district: row.district || null,
      territory: row.territory || null,
      email: row.email || email,
      auth_source: 'google',
      loggedInAt: now,
      expiresAt: now + SESSION_TTL_MS
    }
  })
}
