// Unit tests for api/admin/reset-pin.js — node:test.
// Verifies the dual-write fix: auth.users.password AND public.users.pin_hash
// are updated in the same call.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const Module = require('module')

function registerMock(requestingFile, relPath, exportsObj) {
  const resolved = Module._resolveFilename(relPath, {
    id: requestingFile, filename: requestingFile,
    paths: Module._nodeModulePaths(path.dirname(requestingFile))
  })
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, children: [], paths: [], exports: exportsObj }
  return resolved
}
function resetHandler() {
  const p = path.join(__dirname, '..', 'api', 'admin', 'reset-pin.js')
  delete require.cache[p]
  return p
}
function mockRes() {
  return {
    statusCode: 200, body: null,
    setHeader() {},
    status(c) { this.statusCode = c; return this },
    json(o) { this.body = o; return this },
    end() { return this }
  }
}

// Supabase mock: track auth.admin.updateUserById + .from('users').update().eq()
function makeSupabase(scenario) {
  scenario = scenario || {}
  const calls = { authUpdates: [], pubUpdates: [] }
  return {
    _calls: calls,
    from(_t) {
      let opArg = null
      const filters = []
      const builder = {
        update(row, opts) {
          opArg = row
          // PostgREST returns { data, error, count } shape on .update().eq()
          // We resolve the await on the eq() chain itself (not via .then on update).
          builder._opts = opts || {}
          return builder
        },
        eq(col, val) {
          filters.push([col, val])
          calls.pubUpdates.push({ row: opArg, filters: filters.slice() })
          return Promise.resolve(scenario.pubUpdate || { error: null, count: 1 })
        }
      }
      return builder
    },
    auth: {
      admin: {
        updateUserById: async (id, patch) => {
          calls.authUpdates.push({ id, patch })
          return scenario.authUpdate || { data: { user: { id } }, error: null }
        }
      }
    }
  }
}

function buildEnv({ session = { id: 'mat-uuid', role: 'exec' }, scenario = {} } = {}) {
  const handlerPath = resetHandler()
  const adminDir = path.join(__dirname, '..', 'api', 'admin')
  const sup = makeSupabase(scenario)
  registerMock(handlerPath, path.join(adminDir, '_admin.js'), {
    requireAdmin: async (_req, res) => {
      if (!session) { res.status(401).json({ error: 'Unauthorized' }); return null }
      if (!['service','exec','ceo','admin'].includes(session.role)) { res.status(403).json({ error: 'Admin access required' }); return null }
      return session
    },
    getAdminSupabase: () => sup,
    provisionalPhone: () => '',
    setCors: () => {},
    adminConfigError: () => false
  })
  return { handler: require(handlerPath), calls: sup._calls }
}
function req(body) { return { method: 'POST', headers: {}, body } }

// ─────────────────────────────────────────────────────────────────────────
test('reset-pin updates BOTH auth.password AND public.users.pin_hash', async () => {
  const { handler, calls } = buildEnv({})
  const res = mockRes()
  await handler(req({ user_id: 'jefrey-uuid', new_pin: '5678' }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.public_synced, true)

  // auth side
  assert.equal(calls.authUpdates.length, 1, 'auth.admin.updateUserById called once')
  assert.equal(calls.authUpdates[0].id, 'jefrey-uuid')
  assert.equal(calls.authUpdates[0].patch.password, '5678')

  // public.users side — the dual-write fix
  assert.equal(calls.pubUpdates.length, 1, 'public.users.update called once')
  assert.equal(calls.pubUpdates[0].row.pin_hash, '5678', 'pin_hash matches new_pin')
  assert.deepEqual(calls.pubUpdates[0].filters, [['id', 'jefrey-uuid']], 'scoped to target user')
})

test('reset-pin defaults new_pin to 1234 when omitted', async () => {
  const { handler, calls } = buildEnv({})
  const res = mockRes()
  await handler(req({ user_id: 'jefrey-uuid' }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(calls.authUpdates[0].patch.password, '1234')
  assert.equal(calls.pubUpdates[0].row.pin_hash, '1234')
})

test('reset-pin returns 404 when auth user not found', async () => {
  const { handler, calls } = buildEnv({
    scenario: { authUpdate: { error: { message: 'User not found' } } }
  })
  const res = mockRes()
  await handler(req({ user_id: 'ghost' }), res)
  assert.equal(res.statusCode, 404)
  assert.equal(calls.pubUpdates.length, 0, 'public.users skipped when auth fails')
})

test('reset-pin warns on missing public row but still 200 (auth-only reset)', async () => {
  // Edge case: user has auth.users but not public.users (shouldn't happen
  // under normal portal flow, but guards against drift).
  const { handler } = buildEnv({
    scenario: { pubUpdate: { error: null, count: 0 } }
  })
  const res = mockRes()
  await handler(req({ user_id: 'orphan-auth' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.public_synced, false, 'flagged as auth-only reset')
})

test('reset-pin rejects missing user_id', async () => {
  const { handler } = buildEnv({})
  const res = mockRes()
  await handler(req({}), res)
  assert.equal(res.statusCode, 400)
})

test('reset-pin rejects non-admin session', async () => {
  const { handler, calls } = buildEnv({ session: { id: 'dsm-uuid', role: 'dsm' } })
  const res = mockRes()
  await handler(req({ user_id: 'jefrey-uuid' }), res)
  assert.equal(res.statusCode, 403)
  assert.equal(calls.authUpdates.length, 0, 'no auth call when forbidden')
})

test('reset-pin handles 500 on public.users update with partial-fail msg', async () => {
  const { handler, calls } = buildEnv({
    scenario: { pubUpdate: { error: { message: 'connection broken' }, count: 0 } }
  })
  const res = mockRes()
  await handler(req({ user_id: 'jefrey-uuid' }), res)
  assert.equal(res.statusCode, 500)
  assert.match(res.body.detail, /auth updated but public\.users sync failed/, 'error names which side is broken')
  assert.equal(calls.authUpdates.length, 1, 'auth side did succeed first')
})
