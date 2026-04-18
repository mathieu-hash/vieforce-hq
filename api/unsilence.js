// POST /api/unsilence
// Body: { silence_id }

const { verifySession } = require('./_auth')
const { deactivateSilence } = require('./lib/silence')

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const silence_id = req.body && req.body.silence_id
  if (!silence_id) return res.status(400).json({ error: 'Missing silence_id' })

  const result = await deactivateSilence({ userId: session.id, silenceId: silence_id })
  if (result.error) return res.status(500).json({ error: result.error })
  if (!result.data)  return res.status(404).json({ error: 'Silence not found or not owned by user' })
  return res.json({ ok: true, silence: result.data })
}
