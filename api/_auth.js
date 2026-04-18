const crypto = require('crypto')
const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

async function verifySession(req) {
  const token = req.headers['x-session-id']
  if (!token) return null

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

function getPeriodDates(period) {
  const now = new Date()
  const y = now.getFullYear()
  const m = now.getMonth()
  const d = now.getDate()

  switch (period) {
    case '7D':  return { dateFrom: new Date(y, m, d - 7), dateTo: now }
    case 'MTD': return { dateFrom: new Date(y, m, 1), dateTo: now }
    case 'QTD': return { dateFrom: new Date(y, Math.floor(m / 3) * 3, 1), dateTo: now }
    case 'YTD': return { dateFrom: new Date(y, 0, 1), dateTo: now }
    default:    return { dateFrom: new Date(y, m, 1), dateTo: now }
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
    case 'evp':
    case 'rsm':
    case 'dsm':
    case 'tsr':
      // TODO: Implement region/district filtering via SlpCode JOIN to OSLP
      // For now, all authenticated users see all data (admin-level access)
      // Phase 3 will add: RSM filters by OSLP region, DSM by SlpCode
      return baseWhere
    default:
      return baseWhere + ' AND 1=0'
  }
}

module.exports = { verifySession, verifyServiceToken, getPeriodDates, applyRoleFilter }
