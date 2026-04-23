// POST /api/admin/reset-pin
// Body: { user_id: uuid, new_pin?: string (defaults to '1234') }
// Calls supabase.auth.admin.updateUserById(user_id, { password: new_pin }).

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

  const result = await supabase.auth.admin.updateUserById(user_id, { password: new_pin })
    .catch(e => ({ error: e }))

  if (result.error) {
    const msg = result.error.message || 'reset failed'
    if (/not.*found/i.test(msg)) return res.status(404).json({ error: 'User not found' })
    console.error('[admin/reset-pin] failed:', msg)
    return res.status(500).json({ error: 'Reset failed', detail: msg })
  }

  return res.json({ success: true })
}
