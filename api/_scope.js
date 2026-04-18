// User-scope resolution for HQ endpoints called via the service token.
//
// Patrol passes `?scope=user:<uuid>`; HQ resolves the Supabase user id
// into a set of OCRD.SlpCode values and @SALESDIST district codes to
// filter SAP queries against.
//
// Hierarchy (per step-1 Supabase schema):
//   exec/ceo  → no filter (ALL)
//   rsm       → all DSMs reporting to this RSM, union their TSRs' SlpCodes
//   dsm       → all TSRs reporting to this DSM + DSM's own sap_slpcode + district
//   tsr       → own sap_slpcode
//
// Until sap_slpcode is populated on users rows, dsm/tsr resolutions will
// return empty — callers should short-circuit and return a zero-state payload.

const { createClient } = require('@supabase/supabase-js')

let _supabase = null
function getSupabase() {
  if (_supabase) return _supabase
  const url = process.env.SUPABASE_URL
  // Prefer SERVICE_ROLE (bypasses RLS on deep manager-chain reads);
  // fall back to ANON since HQ's existing users RLS already permits reads.
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY
  if (!url || !key) {
    throw new Error('[scope] SUPABASE_URL + SUPABASE_(SERVICE_ROLE|ANON)_KEY required')
  }
  _supabase = createClient(url, key, { auth: { persistSession: false } })
  return _supabase
}

async function fetchUser(supabase, userId) {
  const { data, error } = await supabase
    .from('users')
    .select('id, role, name, manager_id, sap_slpcode, sap_district_code, district_label, is_active')
    .eq('id', userId)
    .single()
  if (error) return null
  return data
}

async function fetchReports(supabase, managerId, role) {
  const q = supabase
    .from('users')
    .select('id, role, sap_slpcode, sap_district_code, district_label')
    .eq('manager_id', managerId)
    .eq('is_active', true)
  if (role) q.eq('role', role)
  const { data, error } = await q
  if (error) return []
  return data || []
}

// Main entry point. Returns:
//   { userId, role, name, district_label,
//     slpCodes: number[] | 'ALL',
//     districtCodes: number[],
//     is_empty: boolean,
//     error?: string }
async function scopeForUser(userId, supabaseClient) {
  if (!userId) return { userId: null, error: 'missing_userId', is_empty: true, slpCodes: [], districtCodes: [] }

  const supabase = supabaseClient || getSupabase()
  const user = await fetchUser(supabase, userId)

  if (!user) {
    console.warn('[scope] user not found:', userId)
    return { userId, error: 'user_not_found', is_empty: true, slpCodes: [], districtCodes: [] }
  }

  const ctx = {
    userId: user.id,
    role: user.role,
    name: user.name,
    district_label: user.district_label
  }

  // ── exec / ceo / service: no filter ─────────────────────────────────
  if (['exec', 'ceo', 'service', 'admin'].includes(user.role)) {
    return { ...ctx, slpCodes: 'ALL', districtCodes: [], is_empty: false }
  }

  // ── tsr: own sap_slpcode only ───────────────────────────────────────
  if (user.role === 'tsr') {
    const slp = user.sap_slpcode != null ? [Number(user.sap_slpcode)] : []
    return {
      ...ctx,
      slpCodes: slp,
      districtCodes: [],
      is_empty: slp.length === 0
    }
  }

  // ── dsm: own TSRs' SlpCodes + own + district ────────────────────────
  if (user.role === 'dsm') {
    const tsrs = await fetchReports(supabase, userId, 'tsr')
    const slpCodes = tsrs.map(t => t.sap_slpcode).filter(v => v != null).map(Number)
    if (user.sap_slpcode != null) slpCodes.push(Number(user.sap_slpcode))

    const dCode = Number(user.sap_district_code)
    const districtCodes = dCode && dCode !== 0 ? [dCode] : []

    const slpUnique = [...new Set(slpCodes)]
    return {
      ...ctx,
      slpCodes: slpUnique,
      districtCodes,
      is_empty: slpUnique.length === 0 && districtCodes.length === 0
    }
  }

  // ── rsm: walk DSMs → TSRs ───────────────────────────────────────────
  if (user.role === 'rsm') {
    const dsms = await fetchReports(supabase, userId, 'dsm')
    const slpCodes = []
    const districtCodes = []
    if (user.sap_slpcode != null) slpCodes.push(Number(user.sap_slpcode))

    for (const dsm of dsms) {
      if (dsm.sap_slpcode != null) slpCodes.push(Number(dsm.sap_slpcode))
      const dC = Number(dsm.sap_district_code)
      if (dC && dC !== 0) districtCodes.push(dC)
      const tsrs = await fetchReports(supabase, dsm.id, 'tsr')
      for (const t of tsrs) {
        if (t.sap_slpcode != null) slpCodes.push(Number(t.sap_slpcode))
      }
    }

    const slpUnique = [...new Set(slpCodes)]
    const distUnique = [...new Set(districtCodes)]
    return {
      ...ctx,
      slpCodes: slpUnique,
      districtCodes: distUnique,
      is_empty: slpUnique.length === 0 && distUnique.length === 0
    }
  }

  console.warn('[scope] unknown role:', user.role, 'user:', userId)
  return { ...ctx, slpCodes: [], districtCodes: [], is_empty: true }
}

// Build a SQL fragment that scopes an OINV query by the resolved scope.
// Always excludes SlpCode=1 (VPI house account) and CardCode LIKE 'CE%'
// (employee self-invoicing). Scope-match uses EXISTS against OCRD so a
// SlpCode OR district hit satisfies the filter.
//
// Returns: { sql, isEmpty }
//   sql     — string to append to an existing WHERE clause ('' if no filter)
//   isEmpty — true if the scope resolved to nothing (caller should short-circuit)
//
// Notes:
//  • Integer whitelist-check on SlpCode/district values means this string is
//    safe to inline (we do not accept user-supplied numeric lists).
//  • `tableAlias` is the OINV alias in the host query (defaults to `T0`).
function buildScopeWhere(scope, tableAlias = 'T0') {
  if (!scope) return { sql: '', isEmpty: false }
  if (scope.slpCodes === 'ALL') return { sql: '', isEmpty: false }
  if (scope.is_empty) return { sql: '', isEmpty: true }

  const slps = (scope.slpCodes || [])
    .filter(n => Number.isInteger(n) && n > 0 && n !== 1)
  const dists = (scope.districtCodes || [])
    .filter(n => Number.isInteger(n) && n > 0)

  if (!slps.length && !dists.length) return { sql: '', isEmpty: true }

  // Exclude employee self-invoicing CardCodes always when scoping
  const base = [`${tableAlias}.CardCode NOT LIKE 'CE%'`]

  const scopeOr = []
  if (slps.length) {
    scopeOr.push(
      `EXISTS (SELECT 1 FROM OCRD SC WHERE SC.CardCode = ${tableAlias}.CardCode ` +
      `AND SC.SlpCode IN (${slps.join(',')}) AND SC.SlpCode <> 1)`
    )
  }
  if (dists.length) {
    scopeOr.push(
      `EXISTS (SELECT 1 FROM OCRD SC2 WHERE SC2.CardCode = ${tableAlias}.CardCode ` +
      `AND SC2.U_districtName IN (${dists.join(',')}) AND SC2.SlpCode <> 1)`
    )
  }
  base.push('(' + scopeOr.join(' OR ') + ')')

  return { sql: ' AND ' + base.join(' AND '), isEmpty: false }
}

// Empty-state payload identical in shape to /api/sales' normal response
// so Patrol can render a zero-state without branching on error paths.
function emptySalesPayload(scopeMeta) {
  const zeroKpis = {
    volume_mt: 0, volume_bags: 0, revenue: 0, gross_margin: 0, gmt: 0,
    ytd_volume_mt: 0, ytd_volume_bags: 0, ytd_revenue: 0, pending_po_mt: 0,
    delta_pct: { volume_mt: 0, revenue: 0, gmt: 0 },
    last_year: { volume_mt: 0, volume_bags: 0, revenue: 0, ytd_volume_mt: 0, ytd_revenue: 0 },
    delta_pct_ly: { volume_mt: 0, revenue: 0, ytd_volume_mt: 0, ytd_revenue: 0 }
  }
  return {
    scope: scopeMeta,
    kpis: zeroKpis,
    by_brand: [],
    top_customers: [],
    monthly_trend: [],
    pending_po: {
      summary: { total_mt: 0, total_value: 0, total_orders: 0, customers_count: 0, avg_order_mt: 0, oldest_days: 0 },
      by_brand: [], by_region: [], by_sku: [], by_region_detail: [], top_customers: [], detail: []
    },
    volume_mt: 0, volume_bags: 0, revenue: 0, gmt: 0,
    ytd_volume_mt: 0, ytd_revenue: 0
  }
}

// Shape the `scope` metadata for the response envelope.
function scopeResponseMeta(scope) {
  if (!scope) return null
  return {
    userId: scope.userId,
    role: scope.role,
    name: scope.name,
    district_label: scope.district_label,
    slpCodes_count: scope.slpCodes === 'ALL' ? null : (scope.slpCodes || []).length,
    districtCodes_count: (scope.districtCodes || []).length,
    is_empty: !!scope.is_empty,
    ...(scope.error ? { error: scope.error } : {})
  }
}

module.exports = {
  scopeForUser,
  buildScopeWhere,
  emptySalesPayload,
  scopeResponseMeta,
  getSupabase
}
