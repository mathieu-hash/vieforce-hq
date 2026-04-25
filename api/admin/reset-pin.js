// POST /api/admin/reset-pin
// Body: { user_id: uuid, new_pin?: string (defaults to '1234') }
//
// Resets the PIN in BOTH places it lives:
//   1. auth.users.password — Supabase Auth login (Patrol via Edge Fn)
//   2. public.users.pin_hash — HQ dashboard login (js/auth.js plaintext compare)
// They MUST stay in sync; updating only one breaks one of the two login
// paths. See memory feedback_hq_users_pin_hash.md for the historical why.

const { requireAdmin, getAdminSupabase, setCors, adminConfigError } = require('./_admin')

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

  const body = req.body || {}
  const user_id = typeof body.user_id === 'string' ? body.user_id.trim() : ''
  const new_pin = typeof body.new_pin === 'string' && body.new_pin.length >= 4
    ? body.new_pin
    : '1234'

  if (!user_id) return res.status(400).json({ error: 'Missing user_id' })

  // Step 1 — auth.users.password
  const authResult = await supabase.auth.admin.updateUserById(user_id, { password: new_pin })
    .catch(e => ({ error: e }))

  if (authResult.error) {
    const msg = authResult.error.message || 'reset failed'
    if (/not.*found/i.test(msg)) return res.status(404).json({ error: 'User not found' })
    console.error('[admin/reset-pin] auth update failed:', msg)
    return res.status(500).json({ error: 'Reset failed', detail: msg })
  }

  // Step 2 — public.users.pin_hash (kept in sync with auth password so the
  // HQ phone+PIN login path in js/auth.js continues to match). If the row
  // somehow doesn't exist (target had auth.users only), warn but treat the
  // overall reset as successful — the auth path is already updated.
  const { error: pubErr, count } = await supabase
    .from('users')
    .update({ pin_hash: new_pin }, { count: 'exact' })
    .eq('id', user_id)

  if (pubErr) {
    console.error('[admin/reset-pin] public.users update failed:', pubErr.message)
    return res.status(500).json({ error: 'Reset partially failed', detail: 'auth updated but public.users sync failed: ' + pubErr.message })
  }
  if (count === 0) {
    console.warn('[admin/reset-pin] no public.users row for', user_id, '— auth-only reset')
  }

  return res.json({ success: true, public_synced: count > 0 })
}
