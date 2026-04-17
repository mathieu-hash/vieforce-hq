const { verifySession } = require('./_auth')
const { getMeta } = require('./itemized')

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  const session = await verifySession(req)
  if (!session) return res.status(401).json({ error: 'Unauthorized' })
  res.json(getMeta())
}
