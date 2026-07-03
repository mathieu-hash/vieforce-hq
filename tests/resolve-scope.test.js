// Tests for resolveRequestScope — the single decision point for "whose data
// does this caller see". Covers the M1 security fix (user sessions must NOT
// trust a client-supplied ?scope= param) and the SCOPE_USER_SESSIONS gate.

const { test } = require('node:test')
const assert = require('node:assert/strict')
const { resolveRequestScope } = require('../api/_scope')

// Minimal fake Supabase supporting the query shapes scopeForUser uses:
//   fetchUser:    .from('users').select().eq('id', x).single()
//   fetchReports: .from('users').select().eq('manager_id', x).eq('is_active', true)[.eq('role', r)]
function fakeSupabase(usersById) {
  return {
    from() {
      const filters = {}
      const builder = {
        select() { return builder },
        eq(col, val) { filters[col] = val; return builder },
        single() {
          const u = usersById[filters.id]
          return Promise.resolve({ data: u || null, error: u ? null : { message: 'not found' } })
        },
        then(resolve, reject) {
          const rows = Object.values(usersById).filter(u =>
            u.manager_id === filters.manager_id &&
            (filters.role === undefined || u.role === filters.role))
          return Promise.resolve({ data: rows, error: null }).then(resolve, reject)
        }
      }
      return builder
    }
  }
}

const SERVICE = { id: 'svc:patrol', role: 'service', is_service: true }
const users = {
  U_exec: { id: 'U_exec', role: 'exec', sap_slpcode: null, manager_id: null },
  U_tsr:  { id: 'U_tsr',  role: 'tsr',  sap_slpcode: 42, manager_id: 'U_dsm' },
  U_tsr2: { id: 'U_tsr2', role: 'tsr',  sap_slpcode: 99, manager_id: 'U_dsm' }
}

test('service token + ?scope=user:<uuid> → honored', async () => {
  const req = { query: { scope: 'user:U_tsr' } }
  const scope = await resolveRequestScope(req, SERVICE, fakeSupabase(users))
  assert.equal(scope.userId, 'U_tsr')
  assert.deepEqual(scope.slpCodes, [42])
})

test('service token + no scope param → null (national)', async () => {
  const scope = await resolveRequestScope({ query: {} }, SERVICE, fakeSupabase(users))
  assert.equal(scope, null)
})

test('SECURITY: user session ignores a client-supplied ?scope= param', async () => {
  // An exec user session tries to pass scope=user:U_tsr — must be IGNORED
  // (no widening/narrowing from a client param on a user session).
  const req = { query: { scope: 'user:U_tsr' } }
  const session = { id: 'U_exec', role: 'exec' }
  const scope = await resolveRequestScope(req, session, fakeSupabase(users))
  assert.equal(scope, null, 'client scope param must not be honored for a user session')
})

test('user session, flag OFF → null (national, no change from today)', async () => {
  delete process.env.SCOPE_USER_SESSIONS
  const session = { id: 'U_tsr', role: 'tsr' }
  const scope = await resolveRequestScope({ query: {} }, session, fakeSupabase(users))
  assert.equal(scope, null)
})

test('user session, flag ON, field role → derived from OWN session id', async () => {
  process.env.SCOPE_USER_SESSIONS = '1'
  const session = { id: 'U_tsr', role: 'tsr' }
  const scope = await resolveRequestScope({ query: {} }, session, fakeSupabase(users))
  assert.equal(scope.userId, 'U_tsr')
  assert.deepEqual(scope.slpCodes, [42])
  delete process.env.SCOPE_USER_SESSIONS
})

test('SECURITY: flag ON, field role cannot widen via client param', async () => {
  process.env.SCOPE_USER_SESSIONS = '1'
  // tsr passes scope=user:U_exec hoping to see national — must derive from OWN id.
  const req = { query: { scope: 'user:U_exec' } }
  const session = { id: 'U_tsr', role: 'tsr' }
  const scope = await resolveRequestScope(req, session, fakeSupabase(users))
  assert.equal(scope.userId, 'U_tsr', 'derives from session id, not the client param')
  delete process.env.SCOPE_USER_SESSIONS
})

test('user session, flag ON, manager role (exec) → null (national, not scoped)', async () => {
  process.env.SCOPE_USER_SESSIONS = '1'
  const session = { id: 'U_exec', role: 'exec' }
  const scope = await resolveRequestScope({ query: {} }, session, fakeSupabase(users))
  assert.equal(scope, null)
  delete process.env.SCOPE_USER_SESSIONS
})
