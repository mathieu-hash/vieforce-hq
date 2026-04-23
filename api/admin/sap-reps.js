// GET /api/admin/sap-reps
// Returns the 43 active OSLP reps Mat + Joel need to onboard into Supabase
// (SlpCode > 3 to skip placeholder/VPI/Mat/Joel), each left-joined to its
// existing public.users row when sap_slpcode matches.
//
// Also returns:
//   - supabase_managers: the set of already-mapped users eligible to be
//     selected as a manager in the portal UI (role ∈ rsm/director/exec/ceo).
//   - total_reps: count of reps in the `reps` array (not the OSLP table
//     total — 43, not 47).

const { query } = require('../_db')
const { requireAdmin, getAdminSupabase, provisionalPhone, setCors, adminConfigError } = require('./_admin')

module.exports = async (req, res) => {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await requireAdmin(req, res)
  if (!session) return

  let supabase
  try {
    supabase = getAdminSupabase()
  } catch (e) {
    if (adminConfigError(res, e)) return
    return res.status(500).json({ error: 'Supabase init failed', detail: e.message })
  }

  try {
    // ── 1. OSLP roster ──────────────────────────────────────────────────
    const oslpRows = await query(`
      SELECT SlpCode, SlpName, U_rsm, U_director, Memo, Active
      FROM OSLP
      WHERE Active = 'Y' AND SlpCode > 3
      ORDER BY U_rsm, SlpName
    `)

    // ── 2. Supabase users — SELECT via service-role client ──────────────
    const { data: users, error: usersErr } = await supabase
      .from('users')
      .select('id, name, role, phone, sap_slpcode, manager_id, is_active')
      .order('name', { ascending: true })

    if (usersErr) {
      console.error('[admin/sap-reps] users select failed:', usersErr.message)
      return res.status(500).json({ error: 'Supabase read failed', detail: usersErr.message })
    }

    const usersBySlp = new Map()
    for (const u of users || []) {
      if (u.sap_slpcode != null) usersBySlp.set(Number(u.sap_slpcode), u)
    }

    // ── 3. Eligible managers for the UI dropdown ────────────────────────
    const MANAGER_ROLES = new Set(['rsm', 'director', 'exec', 'ceo'])
    const supabase_managers = (users || [])
      .filter(u => u.is_active !== false && MANAGER_ROLES.has(u.role))
      .map(u => ({ id: u.id, name: u.name, role: u.role, sap_slpcode: u.sap_slpcode }))

    // ── 4. Compose response ─────────────────────────────────────────────
    const reps = oslpRows.map(r => {
      const slp = Number(r.SlpCode)
      const is_vacant = typeof r.SlpName === 'string' && r.SlpName.toUpperCase().includes('VACANT')
      const linked = usersBySlp.get(slp) || null
      return {
        slp_code: slp,
        slp_name: r.SlpName,
        u_rsm: r.U_rsm != null ? Number(r.U_rsm) : null,
        u_director: r.U_director != null ? Number(r.U_director) : null,
        memo: r.Memo,
        is_vacant,
        provisional_phone: provisionalPhone(slp),
        manager_hint_name: r.Memo,
        linked_supabase_user: linked ? {
          id: linked.id,
          name: linked.name,
          role: linked.role,
          phone: linked.phone,
          manager_id: linked.manager_id
        } : null
      }
    })

    return res.json({
      reps,
      supabase_managers,
      total_reps: reps.length
    })
  } catch (err) {
    console.error('[admin/sap-reps] error:', err.message)
    return res.status(500).json({ error: 'Database error', detail: err.message })
  }
}
