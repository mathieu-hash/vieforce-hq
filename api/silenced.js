// GET /api/silenced
// Returns the calling user's currently-active silences.

const { verifySession } = require('./_auth')
const { getActiveSilences } = require('./lib/silence')

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const silences = await getActiveSilences(session.id)
  res.json({
    silences,
    count: silences.length,
    user_id: session.id,
    fetched_at: new Date().toISOString()
  })
}
