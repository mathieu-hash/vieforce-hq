// POST /api/margin-ai — server-side Anthropic proxy for the Margin Explorer "AI read".
// Takes the ALREADY-COMPUTED dissection digest and asks Claude to interpret it.
// The API key lives in ANTHROPIC_API_KEY (server env) and is NEVER exposed to the browser.

const { serverError } = require('./lib/http')
const { verifySession, verifyServiceToken } = require('./_auth')

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'x-session-id, authorization, content-type')
  if (req.method === 'OPTIONS') return res.status(200).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const session = (await verifySession(req)) || (await verifyServiceToken(req))
  if (!session) return res.status(401).json({ error: 'Unauthorized' })

  const key = process.env.ANTHROPIC_API_KEY
  if (!key) return res.status(503).json({ error: 'AI read not configured (no ANTHROPIC_API_KEY).' })

  const digest = req.body && req.body.digest
  if (!digest || typeof digest !== 'object') return res.status(400).json({ error: 'Missing digest' })

  const prompt =
    'You are a margin analyst for Vienovo, a Philippine animal-feed manufacturer. ' +
    'Interpret ONLY the already-computed finished-feed margin figures below (all in PHP per tonne). ' +
    'Do NOT invent, recompute, or estimate any numbers — reference only what is given. ' +
    'Write a tight executive read (≤180 words): what moved GM/ton between the base and compare month, ' +
    'the price vs mix vs cost story (from the bridge), the top ingredient cost drivers, the mix shift, ' +
    'and one watch-out. Plain prose, no preamble.\n\nDIGEST (JSON):\n' + JSON.stringify(digest)

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 700, messages: [{ role: 'user', content: prompt }] })
    })
    if (!r.ok) {
      const t = await r.text().catch(() => '')
      console.error('[margin-ai] anthropic', r.status, t.slice(0, 200))
      return res.status(502).json({ error: 'AI upstream error', status: r.status })
    }
    const j = await r.json()
    const text = (j.content || []).map(c => c.text || '').join('').trim()
    res.json({ text, model: 'claude-sonnet-4-6' })
  } catch (e) {
    return serverError(res, e, 'margin-ai')
  }
}
