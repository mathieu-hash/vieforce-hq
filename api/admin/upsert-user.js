// POST /api/admin/upsert-user
// Create or update a Supabase user for a given OSLP SlpCode.
//
// Body:
//   { slp_code: int, name: string, role: string, manager_id: uuid|null,
//     phone: string, create_auth_user?: bool }
//
// Logic:
//   - role === 'exclude'            → delete the user (auth + public)
//   - row exists (by sap_slpcode)  → UPDATE public.users, and auth.users
//                                     phone if it changed
//   - row missing, create_auth=true → createUser in auth, then insert public
//                                     (rolls back the auth row if the insert
//                                      fails — atomic pairing is the point)
//   - row missing, create_auth=false→ insert public.users with a fresh UUID,
//                                     no auth row (lets us map vacants /
//                                     service codes without burning a login)

const { requireAdmin, getAdminSupabase, setCors, adminConfigError } = require('./_admin')

const VALID_ROLES = new Set(['tsr', 'dsm', 'rsm', 'director', 'exec', 'ceo', 'exclude'])
const DEFAULT_PIN = '1234'

// Convert PH local format (09xxxxxxxxx) to E.164 (+639xxxxxxxxx) for Supabase
// Auth, which requires E.164. public.users.phone stays in local format so the
// existing login flow in js/auth.js (phone=cleaned) still works.
function toE164PH(local) {
  if (!/^09\d{9}$/.test(local)) return null
  return '+63' + local.slice(1)
}

function badRequest(res, msg) { return res.status(400).json({ error: msg }) }

module.exports = async (req, res) => {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const session = await requireAdmin(req, res)
  if (!session) return

  let supabase
  try {
    supabase = getAdminSupabase()
  } catch (e) {
    if (adminConfigError(res, e)) return
    return res.status(500).json({ error: 'Supabase init failed', detail: e.message })
  }

  // ── Validate body ─────────────────────────────────────────────────────
  const body = req.body || {}
  const slp_code = Number(body.slp_code)
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const role = typeof body.role === 'string' ? body.role.trim().toLowerCase() : ''
  const manager_id = body.manager_id || null
  const phone = typeof body.phone === 'string' ? body.phone.trim() : ''
  const create_auth_user = body.create_auth_user !== false  // default true

  if (!Number.isInteger(slp_code) || slp_code <= 0) return badRequest(res, 'Invalid slp_code')
  if (!VALID_ROLES.has(role)) return badRequest(res, 'Invalid role')
  if (role !== 'exclude') {
    if (!name) return badRequest(res, 'Missing name')
    if (!phone) return badRequest(res, 'Missing phone')
    if (!/^\d{11}$/.test(phone)) return badRequest(res, 'Phone must be 11 digits (09xxxxxxxxx)')
  }

  // ── Manager validation: if provided, confirm the UUID exists ──────────
  if (manager_id) {
    const { data: mgr, error: mgrErr } = await supabase
      .from('users')
      .select('id')
      .eq('id', manager_id)
      .single()
    if (mgrErr || !mgr) return badRequest(res, 'manager_id does not match any user')
  }

  // ── Look up existing row by sap_slpcode ───────────────────────────────
  const { data: existing, error: findErr } = await supabase
    .from('users')
    .select('id, name, role, phone, sap_slpcode, manager_id')
    .eq('sap_slpcode', slp_code)
    .maybeSingle()

  if (findErr) {
    console.error('[admin/upsert] find failed:', findErr.message)
    return res.status(500).json({ error: 'Supabase read failed', detail: findErr.message })
  }

  // ── Branch 1: EXCLUDE — delete existing row (auth + public) ───────────
  if (role === 'exclude') {
    if (!existing) {
      return res.json({ success: true, action: 'excluded', note: 'no row to delete' })
    }
    const authDel = await supabase.auth.admin.deleteUser(existing.id).catch(e => ({ error: e }))
    if (authDel && authDel.error && !/not.*found/i.test(authDel.error.message || '')) {
      console.warn('[admin/upsert] auth.admin.deleteUser failed (continuing):', authDel.error.message)
    }
    const { error: delErr } = await supabase.from('users').delete().eq('id', existing.id)
    if (delErr) {
      console.error('[admin/upsert] public delete failed:', delErr.message)
      return res.status(500).json({ error: 'Delete failed', detail: delErr.message })
    }
    return res.json({ success: true, action: 'deleted', user_id: existing.id })
  }

  // ── Branch 2: UPDATE existing row ─────────────────────────────────────
  if (existing) {
    const updates = {
      name,
      role,
      manager_id,
      phone,
      hierarchy_updated_at: new Date().toISOString(),
      hierarchy_updated_by: session.id && session.id !== 'svc:patrol' ? session.id : null
    }
    const { data: updated, error: upErr } = await supabase
      .from('users')
      .update(updates)
      .eq('id', existing.id)
      .select('id, name, role, phone, sap_slpcode, manager_id')
      .single()

    if (upErr) {
      console.error('[admin/upsert] update failed:', upErr.message)
      return res.status(500).json({ error: 'Update failed', detail: upErr.message })
    }

    if (existing.phone !== phone) {
      const e164 = toE164PH(phone)
      if (e164) {
        const phoneUpd = await supabase.auth.admin.updateUserById(existing.id, { phone: e164 }).catch(e => ({ error: e }))
        if (phoneUpd && phoneUpd.error) {
          console.warn('[admin/upsert] auth phone update failed (public row updated):', phoneUpd.error.message)
        }
      }
    }

    return res.json({ success: true, action: 'updated', user: updated })
  }

  // ── Branch 3a: CREATE with auth user ─────────────────────────────────
  if (create_auth_user) {
    const e164 = toE164PH(phone)
    if (!e164) return badRequest(res, 'phone must be PH local format 09XXXXXXXXX')

    const createRes = await supabase.auth.admin.createUser({
      phone: e164,
      password: DEFAULT_PIN,
      phone_confirm: true,
      user_metadata: {
        sap_slpcode: slp_code,
        source: 'admin_portal',
        onboarded_by: session.id
      }
    }).catch(e => ({ error: e }))

    if (createRes.error) {
      const msg = createRes.error.message || 'auth create failed'
      if (/already.*registered|duplicate|already exists/i.test(msg)) {
        return res.status(409).json({ error: 'Phone already registered', detail: msg })
      }
      console.error('[admin/upsert] auth create failed:', msg)
      return res.status(500).json({ error: 'Auth create failed', detail: msg })
    }

    const authUserId = createRes.data && createRes.data.user && createRes.data.user.id
    if (!authUserId) {
      return res.status(500).json({ error: 'Auth create returned no id' })
    }

    const insert = {
      id: authUserId,
      name,
      role,
      phone,
      pin_hash: DEFAULT_PIN,       // NOT NULL column; HQ js/auth.js compares plaintext
      sap_slpcode: slp_code,
      manager_id,
      is_active: true,
      hierarchy_updated_at: new Date().toISOString(),
      hierarchy_updated_by: session.id && session.id !== 'svc:patrol' ? session.id : null
    }

    const { data: inserted, error: insErr } = await supabase
      .from('users')
      .insert(insert)
      .select('id, name, role, phone, sap_slpcode, manager_id')
      .single()

    if (insErr) {
      console.error('[admin/upsert] public insert failed, rolling back auth:', insErr.message)
      const rb = await supabase.auth.admin.deleteUser(authUserId).catch(e => ({ error: e }))
      if (rb && rb.error) console.error('[admin/upsert] ROLLBACK FAILED — orphan auth user', authUserId, rb.error.message)
      return res.status(500).json({ error: 'Insert failed', detail: insErr.message, rollback: rb && rb.error ? 'failed' : 'ok' })
    }

    return res.json({ success: true, action: 'created', user: inserted })
  }

  // ── Branch 3b: CREATE public only (no auth login) ────────────────────
  const insertNoAuth = {
    name,
    role,
    phone,
    pin_hash: DEFAULT_PIN,
    sap_slpcode: slp_code,
    manager_id,
    is_active: true,
    hierarchy_updated_at: new Date().toISOString(),
    hierarchy_updated_by: session.id && session.id !== 'svc:patrol' ? session.id : null
  }
  const { data: inserted, error: insErr } = await supabase
    .from('users')
    .insert(insertNoAuth)
    .select('id, name, role, phone, sap_slpcode, manager_id')
    .single()

  if (insErr) {
    console.error('[admin/upsert] no-auth insert failed:', insErr.message)
    return res.status(500).json({ error: 'Insert failed', detail: insErr.message })
  }
  return res.json({ success: true, action: 'created_no_auth', user: inserted })
}
