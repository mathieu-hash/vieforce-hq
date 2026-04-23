// Unit tests for api/admin/upsert-user.js — node:test.
// Covers create-atomic, update, exclude, auth rollback, duplicate phone, auth gate.

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const Module = require('module')

function registerMock(requestingFile, relPath, exportsObj) {
  const resolved = Module._resolveFilename(relPath, {
    id: requestingFile, filename: requestingFile,
    paths: Module._nodeModulePaths(path.dirname(requestingFile))
  })
  require.cache[resolved] = {
    id: resolved, filename: resolved, loaded: true, children: [], paths: [],
    exports: exportsObj
  }
  return resolved
}

function resetHandler() {
  const p = path.join(__dirname, '..', 'api', 'admin', 'upsert-user.js')
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

// ── Full Supabase mock: chainable query builder + auth.admin.* ──
// `scenario` shape controls behavior per test:
//   {
//     existingBySlp: <row|null>   — what .eq('sap_slpcode', N).maybeSingle() returns
//     managerExists: <bool>       — what .eq('id', mgrId).single() returns
//     createUserResult: <obj>     — what auth.admin.createUser() returns
//     insertResult: <{data,error}>
//     updateResult: <{data,error}>
//     deleteResult: <{error}>
//     authDeleteResult: <{error}>
//   }
function makeSupabase(scenario) {
  const calls = { authCreated: [], authDeleted: [], authUpdated: [], insert: [], update: [], delete: [] }

  function fromUsers() {
    let op = null
    let opArg = null
    const filters = []
    const builder = {
      select() { return builder },
      insert(row) { op = 'insert'; opArg = row; return builder },
      update(row) { op = 'update'; opArg = row; return builder },
      delete() { op = 'delete'; return builder },
      eq(col, val) { filters.push([col, val]); return builder },
      order() { return builder },
      maybeSingle() {
        if (filters.some(([c]) => c === 'sap_slpcode')) {
          return Promise.resolve({ data: scenario.existingBySlp || null, error: null })
        }
        return Promise.resolve({ data: null, error: null })
      },
      single() {
        if (op === null && filters.some(([c]) => c === 'id')) {
          return Promise.resolve({
            data: scenario.managerExists ? { id: filters.find(([c]) => c === 'id')[1] } : null,
            error: scenario.managerExists ? null : { message: 'not found' }
          })
        }
        if (op === 'insert') {
          calls.insert.push(opArg)
          const r = scenario.insertResult || { data: { ...opArg, id: opArg.id || 'generated-uuid' }, error: null }
          return Promise.resolve(r)
        }
        if (op === 'update') {
          calls.update.push(opArg)
          const r = scenario.updateResult || { data: { id: 'uid', ...opArg }, error: null }
          return Promise.resolve(r)
        }
        return Promise.resolve({ data: null, error: { message: 'no-op' } })
      },
      then(resolve) {
        if (op === 'delete') {
          calls.delete.push(filters)
          resolve(scenario.deleteResult || { error: null })
        } else {
          resolve({ data: null, error: null })
        }
      }
    }
    return builder
  }

  return {
    _calls: calls,
    from() { return fromUsers() },
    auth: {
      admin: {
        createUser: async (payload) => {
          calls.authCreated.push(payload)
          return scenario.createUserResult || { data: { user: { id: 'new-auth-uuid' } }, error: null }
        },
        updateUserById: async (id, patch) => {
          calls.authUpdated.push({ id, patch })
          return { data: { user: { id } }, error: null }
        },
        deleteUser: async (id) => {
          calls.authDeleted.push(id)
          return scenario.authDeleteResult || { data: null, error: null }
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
      if (!['service','exec','ceo'].includes(session.role)) { res.status(403).json({ error: 'Admin access required' }); return null }
      return session
    },
    getAdminSupabase: () => sup,
    provisionalPhone: (n) => '09180000' + String(n).padStart(3, '0'),
    setCors: () => {},
    adminConfigError: () => false
  })
  return { handler: require(handlerPath), calls: sup._calls }
}

function req(body) { return { method: 'POST', headers: {}, body } }

// ─────────────────────────────────────────────────────────────────────────
test('upsert_creates_auth_and_public_user_atomically', async () => {
  const { handler, calls } = buildEnv({
    scenario: {
      existingBySlp: null,
      managerExists: true,
      createUserResult: { data: { user: { id: 'new-auth-uuid' } }, error: null }
    }
  })
  const res = mockRes()
  await handler(req({
    slp_code: 17, name: 'Jefrey Gatchalian', role: 'dsm',
    manager_id: 'edfrey-uuid', phone: '09180000017'
  }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.success, true)
  assert.equal(res.body.action, 'created')
  assert.equal(calls.authCreated.length, 1)
  assert.equal(calls.authCreated[0].phone, '09180000017')
  assert.equal(calls.authCreated[0].password, '1234')
  assert.equal(calls.insert.length, 1)
  assert.equal(calls.insert[0].id, 'new-auth-uuid')
  assert.equal(calls.insert[0].sap_slpcode, 17)
  assert.equal(calls.authDeleted.length, 0, 'no rollback on happy path')
})

test('upsert_rolls_back_auth_when_public_insert_fails', async () => {
  const { handler, calls } = buildEnv({
    scenario: {
      existingBySlp: null,
      managerExists: true,
      createUserResult: { data: { user: { id: 'orphan-auth-uuid' } }, error: null },
      insertResult: { data: null, error: { message: 'constraint violated' } }
    }
  })
  const res = mockRes()
  await handler(req({
    slp_code: 17, name: 'Jefrey', role: 'dsm',
    manager_id: 'edfrey-uuid', phone: '09180000017'
  }), res)

  assert.equal(res.statusCode, 500)
  assert.equal(res.body.rollback, 'ok')
  assert.deepEqual(calls.authDeleted, ['orphan-auth-uuid'], 'auth user deleted on rollback')
})

test('upsert_updates_existing_user_when_slp_code_already_mapped', async () => {
  const { handler, calls } = buildEnv({
    scenario: {
      existingBySlp: { id: 'existing-uuid', name: 'Old Name', role: 'tsr',
                       phone: '09180000017', sap_slpcode: 17, manager_id: null },
      managerExists: true
    }
  })
  const res = mockRes()
  await handler(req({
    slp_code: 17, name: 'Jefrey Gatchalian', role: 'dsm',
    manager_id: 'edfrey-uuid', phone: '09180000017'
  }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.action, 'updated')
  assert.equal(calls.update.length, 1)
  assert.equal(calls.update[0].role, 'dsm')
  assert.equal(calls.update[0].manager_id, 'edfrey-uuid')
  assert.equal(calls.authCreated.length, 0, 'no new auth user for update path')
})

test('upsert_exclude_role_deletes_both_auth_and_public_row', async () => {
  const { handler, calls } = buildEnv({
    scenario: {
      existingBySlp: { id: 'tbd-uuid', role: 'tsr', sap_slpcode: 99 }
    }
  })
  const res = mockRes()
  await handler(req({
    slp_code: 99, name: 'Ghost', role: 'exclude', manager_id: null, phone: '09180000099'
  }), res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.action, 'deleted')
  assert.deepEqual(calls.authDeleted, ['tbd-uuid'])
  assert.equal(calls.delete.length, 1)
})

test('upsert_rejects_non_exec_session', async () => {
  const { handler } = buildEnv({
    session: { id: 'dsm-uuid', role: 'dsm' }, scenario: {}
  })
  const res = mockRes()
  await handler(req({
    slp_code: 17, name: 'X', role: 'dsm', manager_id: null, phone: '09180000017'
  }), res)
  assert.equal(res.statusCode, 403)
})

test('upsert_returns_409_on_duplicate_phone', async () => {
  const { handler } = buildEnv({
    scenario: {
      existingBySlp: null,
      managerExists: true,
      createUserResult: { error: { message: 'A user with this phone number already registered.' } }
    }
  })
  const res = mockRes()
  await handler(req({
    slp_code: 17, name: 'Jefrey', role: 'dsm', manager_id: 'edfrey-uuid', phone: '09180000017'
  }), res)
  assert.equal(res.statusCode, 409)
})

test('upsert_rejects_invalid_role', async () => {
  const { handler } = buildEnv({ scenario: {} })
  const res = mockRes()
  await handler(req({
    slp_code: 17, name: 'X', role: 'superadmin', manager_id: null, phone: '09180000017'
  }), res)
  assert.equal(res.statusCode, 400)
})

test('upsert_rejects_bad_phone_format', async () => {
  const { handler } = buildEnv({ scenario: {} })
  const res = mockRes()
  await handler(req({
    slp_code: 17, name: 'X', role: 'dsm', manager_id: null, phone: '+63 917 12345'
  }), res)
  assert.equal(res.statusCode, 400)
})
