const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

let _sessionSupabase = null
function getSessionSupabase() {
  if (_sessionSupabase) return _sessionSupabase
  const url = process.env.SUPABASE_URL
  // Prefer service role: public.users RLS blocks anon after lock-users-rls.sql.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) return null
  _sessionSupabase = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  })
  return _sessionSupabase
}

async function verifySession(req) {
  const token = req.headers['x-session-id']
  if (!token) return null

  const supabase = getSessionSupabase()
  if (!supabase) return null

  const { data: user } = await supabase
    .from('users')
    .select('id, name, role, region, district, territory')
    .eq('id', token)
    .eq('is_active', true)
    .single()

  return user || null
}

// Service-to-service auth via shared bearer token.
// Used by Patrol backend (and any future internal consumer) to call HQ endpoints
// without a Supabase user. No DB round-trip on the hot path.
async function verifyServiceToken(req) {
  const auth = req.headers.authorization || ''
  if (!auth.startsWith('Bearer ')) return null
  const token = auth.slice(7).trim()
  const expected = process.env.HQ_SERVICE_TOKEN
  if (!expected || token.length !== expected.length) return null

  const ok = crypto.timingSafeEqual(
    Buffer.from(token),
    Buffer.from(expected)
  )
  if (!ok) return null

  console.log('[svc-auth] request authenticated:', req.url)

  // Synthetic session — applyRoleFilter treats role='service' as full-scope.
  return {
    id: 'svc:patrol',
    name: 'Patrol Service',
    role: 'service',
    region: 'ALL',
    district: 'ALL',
    territory: null,
    is_service: true
  }
}

const { resolveRefMonthAnchor } = require('./lib/shipping_days')

/**
 * @param {string} period  7D | MTD | QTD | YTD
 * @param {{ refMonth?: string, ref_month?: string }} [opts]
 */
function getPeriodDates(period, opts) {
  opts = opts || {}
  const refRaw = opts.refMonth || opts.ref_month
  const anchor = resolveRefMonthAnchor(typeof refRaw === 'string' ? refRaw : '')
  const y = anchor.getFullYear()
  const m = anchor.getMonth()
  const d = anchor.getDate()

  switch (period) {
    // Inclusive SQL BETWEEN means anchor-6 through anchor is the true 7-day window.
    case '7D':  return { dateFrom: new Date(y, m, d - 6), dateTo: anchor }
    case 'MTD': return { dateFrom: new Date(y, m, 1), dateTo: anchor }
    case 'QTD': return { dateFrom: new Date(y, Math.floor(m / 3) * 3, 1), dateTo: anchor }
    case 'YTD': return { dateFrom: new Date(y, 0, 1), dateTo: anchor }
    default:    return { dateFrom: new Date(y, m, 1), dateTo: anchor }
  }
}

// NOTE: String interpolation in role filters is safe here because session.region
// and session.name come from our own Supabase users table (not user input).
// These values are set by admins and never contain untrusted data.
function applyRoleFilter(session, baseWhere) {
  if (!session) return baseWhere + ' AND 1=0'
  switch (session.role) {
    case 'service':
      // Service role — Patrol proxy will re-scope downstream.
      // Equivalent to exec/ceo scope at the SAP boundary; the calling service
      // is responsible for filtering per-user before returning to its own clients.
      return baseWhere
    case 'admin':
    case 'ceo':
    case 'exec':
    case 'evp':
    case 'director':
    case 'marketing':
    case 'rsm':
    case 'dsm':
    case 'tsr':
      // TODO: Implement region/district filtering via SlpCode JOIN to OSLP
      // For now, all authenticated users see all data (admin-level access)
      // Phase 3 will add: RSM filters by OSLP region, DSM by SlpCode
      // NOTE: this list MUST cover every role in public.users — an unlisted role
      // falls through to `AND 1=0` and silently zeroes all OINV revenue/GM/margin
      // (volume via ODLN bypasses this filter, so the symptom is "money = 0 but
      // volume works"). Roles present 2026-06: admin/exec/evp/director/rsm/dsm/tsr.
      return baseWhere
    default:
      console.warn('[applyRoleFilter] unlisted role -> zeroed scope:', session.role)
      return baseWhere + ' AND 1=0'
  }
}

module.exports = { verifySession, verifyServiceToken, getPeriodDates, applyRoleFilter }
