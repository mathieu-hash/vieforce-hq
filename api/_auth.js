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
    case 'admin':
    case 'ceo':
    case 'evp':
      return baseWhere
    case 'rsm':
      return baseWhere + ` AND T0.U_Region = '${session.region}'`
    case 'dsm':
      return baseWhere + ` AND T0.SlpName = '${session.name}'`
    default:
      return baseWhere + ' AND 1=0'
  }
}

module.exports = { verifySession, getPeriodDates, applyRoleFilter }
