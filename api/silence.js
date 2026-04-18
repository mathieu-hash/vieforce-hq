// POST /api/silence
// Body: { alert_type, customer_code, duration_days (int or null), note (opt), customer_name (opt) }

const { verifySession } = require('./_auth')
const { createSilence } = require('./lib/silence')

const VALID_TYPES = new Set([
  'rescue', 'grow', 'warning', 'legacy_ar',
  'margin_critical', 'margin_warning', 'dormant_active'
])

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const body = req.body || {}
  const alert_type = String(body.alert_type || '').trim()
  const customer_code = String(body.customer_code || '').trim()
  const duration_days = body.duration_days == null ? null : Number(body.duration_days)
  const note = body.note ? String(body.note).slice(0, 500) : null
  const customer_name = body.customer_name ? String(body.customer_name).slice(0, 200) : null

  if (!VALID_TYPES.has(alert_type)) {
    return res.status(400).json({ error: 'Invalid alert_type. Must be one of: ' + [...VALID_TYPES].join(', ') })
  }
  if (!customer_code) {
    return res.status(400).json({ error: 'Missing customer_code' })
  }
  if (duration_days != null && (!Number.isFinite(duration_days) || duration_days <= 0 || duration_days > 3650)) {
    return res.status(400).json({ error: 'duration_days must be a positive number ≤ 3650, or null for forever' })
  }

  const result = await createSilence({
    userId:        session.id,
    alertType:     alert_type,
    customerCode:  customer_code,
    durationDays:  duration_days,
    note,
    customerName:  customer_name
  })
  if (result.error) {
    // Table might not exist yet (pre-migration)
    if (/relation .* does not exist/i.test(result.error)) {
      return res.status(503).json({
        error: 'Silence table not provisioned',
        hint: 'Run migrations/supabase_silenced_alerts.sql in Supabase SQL Editor first.'
      })
    }
    return res.status(500).json({ error: result.error })
  }
  return res.json({ ok: true, silence: result.data })
}
