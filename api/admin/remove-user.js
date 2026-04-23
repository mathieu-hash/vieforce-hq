// DELETE /api/admin/remove-user
// Body: { user_id: uuid }
// Hard-deletes auth.users row then public.users row. Guards:
//   - cannot delete self (session.id === user_id)
//   - cannot delete a user with role='ceo' (protect Mat's account type)

const { requireAdmin, getAdminSupabase, setCors, adminConfigError } = require('./_admin')

module.exports = async (req, res) => {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'DELETE') return res.status(405).json({ error: 'Method not allowed' })

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
  if (!user_id) return res.status(400).json({ error: 'Missing user_id' })

  if (session.id && session.id === user_id) {
    return res.status(400).json({ error: 'Cannot delete self' })
  }

  // Confirm target role — block removal of 'ceo' accounts.
  const { data: target, error: tErr } = await supabase
    .from('users')
    .select('id, role, name')
    .eq('id', user_id)
    .single()

  if (tErr || !target) {
    return res.status(404).json({ error: 'User not found' })
  }
  if (target.role === 'ceo') {
    return res.status(400).json({ error: 'Cannot delete CEO account' })
  }

  // Delete auth first (silently tolerates "not found" — orphaned public row is
  // still worth cleaning up if its auth partner vanished some other way).
  const authDel = await supabase.auth.admin.deleteUser(user_id).catch(e => ({ error: e }))
  if (authDel && authDel.error && !/not.*found/i.test(authDel.error.message || '')) {
    console.warn('[admin/remove] auth delete warning (continuing):', authDel.error.message)
  }

  const { error: pubErr } = await supabase.from('users').delete().eq('id', user_id)
  if (pubErr) {
    console.error('[admin/remove] public delete failed:', pubErr.message)
    return res.status(500).json({ error: 'Delete failed', detail: pubErr.message })
  }

  return res.json({ success: true, user_id, name: target.name })
}
