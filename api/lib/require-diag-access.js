// Access control for GET /api/diag — executive-level + admin app users only.
// Optional: DISABLE_DIAG=1 (404), DIAG_ALLOW_SERVICE_TOKEN=1 (Patrol S2S for ops).
//
// Default verifiers are loaded lazily so unit tests can inject mocks without env/supabase.

/** Roles that may run SAP diagnostic probes (field roles excluded). */
const EXEC_LEVEL_ROLES = new Set(['exec', 'ceo', 'admin', 'evp', 'director'])

/**
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {{ verifySession?: function, verifyServiceToken?: function }} [overrides] for tests only
 * @returns {Promise<object|null>} session object or null after sending response
 */
async function requireDiagAccess(req, res, overrides = {}) {
  const verifySess =
    overrides.verifySession ?? require('../_auth').verifySession
  const verifySvc =
    overrides.verifyServiceToken ?? require('../_auth').verifyServiceToken

  const env = (k) => String(process.env[k] || '')
  if (env('DISABLE_DIAG') === '1' || /^true$/i.test(env('DISABLE_DIAG'))) {
    res.status(404).json({ error: 'Not found' })
    return null
  }

  const allowService =
    env('DIAG_ALLOW_SERVICE_TOKEN') === '1' || /^true$/i.test(env('DIAG_ALLOW_SERVICE_TOKEN'))
  if (allowService) {
    const svc = await verifySvc(req)
    if (svc) return svc
  }

  const session = await verifySess(req)
  if (!session) {
    res.status(401).json({ error: 'Unauthorized' })
    return null
  }
  if (!EXEC_LEVEL_ROLES.has(session.role)) {
    res.status(403).json({ error: 'Diagnostics access denied' })
    return null
  }
  return session
}

module.exports = { requireDiagAccess, EXEC_LEVEL_ROLES }
