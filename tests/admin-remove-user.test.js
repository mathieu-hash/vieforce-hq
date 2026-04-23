// Unit tests for api/admin/remove-user.js — node:test.

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
  const p = path.join(__dirname, '..', 'api', 'admin', 'remove-user.js')
  delete require.cache[p]
  return p
}
function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader() {},
    status(c) { this.statusCode = c; return this },
    json(o) { this.body = o; return this },
    end() { return this }
  }
}

function makeSupabase(targetRow) {
  const calls = { authDeleted: [], publicDeleted: [] }
  return {
    _calls: calls,
    from(_table) {
      let op = null
      const filters = []
      const builder = {
        select() { return builder },
        delete() { op = 'delete'; return builder },
        eq(col, val) { filters.push([col, val]); return builder },
        single() {
          return Promise.resolve({ data: targetRow, error: targetRow ? null : { message: 'not found' } })
        },
        then(resolve) {
          if (op === 'delete') calls.publicDeleted.push(filters)
          resolve({ error: null })
        }
      }
      return builder
    },
    auth: {
      admin: {
        deleteUser: async (id) => { calls.authDeleted.push(id); return { error: null } }
      }
    }
  }
}

function buildEnv({ session = { id: 'mat-uuid', role: 'exec' }, targetRow = null } = {}) {
  const handlerPath = resetHandler()
  const adminDir = path.join(__dirname, '..', 'api', 'admin')
  const sup = makeSupabase(targetRow)
  registerMock(handlerPath, path.join(adminDir, '_admin.js'), {
    requireAdmin: async (_req, res) => {
      if (!session) { res.status(401).json({ error: 'Unauthorized' }); return null }
      if (!['service','exec','ceo'].includes(session.role)) { res.status(403).json({ error: 'Admin access required' }); return null }
      return session
    },
    getAdminSupabase: () => sup,
    provisionalPhone: () => '',
    setCors: () => {},
    adminConfigError: () => false
  })
  return { handler: require(handlerPath), calls: sup._calls }
}
function req(body) { return { method: 'DELETE', headers: {}, body } }

// ─────────────────────────────────────────────────────────────────────────
test('remove_user_cannot_delete_self', async () => {
  const { handler, calls } = buildEnv({
    session: { id: 'mat-uuid', role: 'exec' }
  })
  const res = mockRes()
  await handler(req({ user_id: 'mat-uuid' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error, 'Cannot delete self')
  assert.equal(calls.authDeleted.length, 0)
})

test('remove_user_cannot_delete_ceo', async () => {
  const { handler, calls } = buildEnv({
    targetRow: { id: 'ceo-uuid', role: 'ceo', name: 'CEO' }
  })
  const res = mockRes()
  await handler(req({ user_id: 'ceo-uuid' }), res)
  assert.equal(res.statusCode, 400)
  assert.equal(res.body.error, 'Cannot delete CEO account')
  assert.equal(calls.authDeleted.length, 0)
})

test('remove_user_deletes_auth_and_public_on_happy_path', async () => {
  const { handler, calls } = buildEnv({
    targetRow: { id: 'jefrey-uuid', role: 'dsm', name: 'Jefrey' }
  })
  const res = mockRes()
  await handler(req({ user_id: 'jefrey-uuid' }), res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.deepEqual(calls.authDeleted, ['jefrey-uuid'])
  assert.equal(calls.publicDeleted.length, 1)
})

test('remove_user_404_when_target_missing', async () => {
  const { handler } = buildEnv({ targetRow: null })
  const res = mockRes()
  await handler(req({ user_id: 'ghost-uuid' }), res)
  assert.equal(res.statusCode, 404)
})

test('remove_user_rejects_non_exec_session', async () => {
  const { handler } = buildEnv({
    session: { id: 'dsm-uuid', role: 'dsm' },
    targetRow: { id: 'target-uuid', role: 'tsr', name: 'T' }
  })
  const res = mockRes()
  await handler(req({ user_id: 'target-uuid' }), res)
  assert.equal(res.statusCode, 403)
})
