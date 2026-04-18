// Silence system — shared helpers.
// Backend reads/writes `silenced_alerts` in Supabase (same project as users table).
// For schema see: migrations/supabase_silenced_alerts.sql

const { createClient } = require('@supabase/supabase-js')

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
)

/**
 * Read all currently-active silences for a user.
 * Active = `active = true` AND (`silenced_until` IS NULL OR > NOW()).
 *
 * Returns: array of { id, alert_type, customer_code, silenced_at,
 *                     silenced_until, note, customer_name }
 * On Supabase error or if table doesn't exist yet: returns [] (graceful).
 */
async function getActiveSilences(userId) {
  if (!userId) return []
  try {
    const { data, error } = await supabase
      .from('silenced_alerts')
      .select('id, alert_type, customer_code, silenced_at, silenced_until, note, customer_name')
      .eq('user_id', userId)
      .eq('active', true)
      .or(`silenced_until.is.null,silenced_until.gt.${new Date().toISOString()}`)
    if (error) {
      // 42P01 = table does not exist — log and return empty (non-fatal)
      const msg = error.message || ''
      const tableMissing = /relation .* does not exist/i.test(msg) ||
                           /could not find the table/i.test(msg) ||
                           /schema cache/i.test(msg)
      if (!tableMissing) console.warn('[silence] read error:', msg)
      return []
    }
    return data || []
  } catch (e) {
    console.warn('[silence] unexpected read error:', e.message)
    return []
  }
}

/**
 * Build a fast-lookup Set of "alertType::customerCode" keys from a silences
 * array — cheap O(1) membership tests during per-row filter loops.
 */
function buildSilenceIndex(silences) {
  const set = new Set()
  for (const s of silences) {
    set.add(`${s.alert_type}::${s.customer_code}`)
  }
  return set
}

function isSilenced(silenceIdx, alertType, customerCode) {
  if (!silenceIdx || !customerCode) return false
  return silenceIdx.has(`${alertType}::${customerCode}`)
}

/**
 * Filter an array of alert rows, removing those that match an active silence.
 * Returns { kept, removed_count }.
 */
function applySilenceFilter(rows, alertType, silenceIdx, codeFn) {
  if (!silenceIdx || silenceIdx.size === 0) return { kept: rows, removed_count: 0 }
  const get = codeFn || (r => r.card_code || r.CardCode || r.customer_code || r.code)
  let removed = 0
  const kept = rows.filter(r => {
    if (isSilenced(silenceIdx, alertType, get(r))) { removed++; return false }
    return true
  })
  return { kept, removed_count: removed }
}

/**
 * Insert a new silence row. Returns the inserted row or null on error.
 * Parameters:
 *   - userId (from session)
 *   - alertType ('rescue'|'grow'|'warning'|'legacy_ar'|'margin_critical'|'margin_warning'|'dormant_active')
 *   - customerCode
 *   - durationDays (null = forever)
 *   - note (optional)
 *   - customerName (optional denormalised display name)
 */
async function createSilence({ userId, alertType, customerCode, durationDays, note, customerName }) {
  if (!userId || !alertType || !customerCode) {
    return { error: 'Missing required fields' }
  }
  let silenced_until = null
  if (durationDays != null && Number.isFinite(Number(durationDays)) && Number(durationDays) > 0) {
    silenced_until = new Date(Date.now() + Number(durationDays) * 86400000).toISOString()
  }
  const payload = {
    user_id:         userId,
    alert_type:      alertType,
    customer_code:   customerCode,
    customer_name:   customerName || null,
    silenced_until,
    note:            note || null,
    active:          true
  }
  const { data, error } = await supabase
    .from('silenced_alerts')
    .insert(payload)
    .select()
    .single()
  if (error) {
    console.warn('[silence] insert error:', error.message)
    return { error: error.message }
  }
  return { data }
}

/**
 * Deactivate (unsilence) a row by id. Scoped to userId for safety — can only
 * unsilence your own rows.
 */
async function deactivateSilence({ userId, silenceId }) {
  if (!userId || !silenceId) return { error: 'Missing fields' }
  const { data, error } = await supabase
    .from('silenced_alerts')
    .update({ active: false })
    .eq('id', silenceId)
    .eq('user_id', userId)
    .select()
    .single()
  if (error) {
    console.warn('[silence] update error:', error.message)
    return { error: error.message }
  }
  return { data }
}

module.exports = {
  getActiveSilences,
  buildSilenceIndex,
  isSilenced,
  applySilenceFilter,
  createSilence,
  deactivateSilence
}
