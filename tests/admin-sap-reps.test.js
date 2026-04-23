// Unit tests for api/admin/sap-reps.js — node:test.
// Run: node --test tests/admin-sap-reps.test.js   (or: npm test)

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
  const p = path.join(__dirname, '..', 'api', 'admin', 'sap-reps.js')
  delete require.cache[p]
  return p
}

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    status(code) { this.statusCode = code; return this },
    json(obj)    { this.body = obj; return this },
    end()        { return this }
  }
}

// ── Supabase mock: only needs .from('users').select().order() in this path ──
function makeSupabaseStub(usersRows) {
  return {
    from(_table) {
      const state = { rows: usersRows }
      const builder = {
        select() { return builder },
        order() {
          return Promise.resolve({ data: state.rows, error: null })
        }
      }
      return builder
    }
  }
}

// Canned OSLP query result
const OSLP_ROWS = [
  { SlpCode: 4,  SlpName: 'ABEGAIL PAGTAMA',     U_rsm: 10, U_director: 3, Memo: 'EDFREY BUENAVENTURA', Active: 'Y' },
  { SlpCode: 10, SlpName: 'EDFREY BUENAVENTURA', U_rsm: 10, U_director: 3, Memo: 'EDFREY BUENAVENTURA', Active: 'Y' },
  { SlpCode: 17, SlpName: 'JEFREY GATCHALIAN',   U_rsm: 10, U_director: 3, Memo: 'EDFREY BUENAVENTURA', Active: 'Y' },
  { SlpCode: 34, SlpName: 'VACANT - ILOCOS',     U_rsm: 10, U_director: 3, Memo: 'EDFREY BUENAVENTURA', Active: 'Y' }
]

function buildEnv({ session = { id: 'mat-uuid', role: 'exec' }, supabaseUsers = [] } = {}) {
  const handlerPath = resetHandler()
  const apiDir = path.join(__dirname, '..', 'api')
  const adminDir = path.join(apiDir, 'admin')

  // Stub _admin helpers — simplest path: bypass auth + inject Supabase client.
  registerMock(handlerPath, path.join(adminDir, '_admin.js'), {
    requireAdmin: async (_req, res) => {
      if (!session) { res.status(401).json({ error: 'Unauthorized' }); return null }
      if (!['service','exec','ceo'].includes(session.role)) { res.status(403).json({ error: 'Admin access required' }); return null }
      return session
    },
    getAdminSupabase: () => makeSupabaseStub(supabaseUsers),
    provisionalPhone: (n) => '09180000' + String(n).padStart(3, '0'),
    setCors: () => {},
    adminConfigError: () => false
  })

  // Stub _db.query → OSLP canned rows
  registerMock(handlerPath, path.join(apiDir, '_db.js'), {
    query: async () => OSLP_ROWS,
    queryH: async () => [],
    queryBoth: async () => []
  })

  return require(handlerPath)
}

// ─────────────────────────────────────────────────────────────────────────
test('admin_sap_reps_returns_all_reps_with_provisional_phones', async () => {
  const handler = buildEnv({ supabaseUsers: [] })
  const req = { method: 'GET', headers: {}, query: {} }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.total_reps, 4)
  assert.equal(res.body.reps.length, 4)
  // Phone pattern verification
  const jefrey = res.body.reps.find(r => r.slp_code === 17)
  assert.equal(jefrey.provisional_phone, '09180000017')
  assert.equal(jefrey.is_vacant, false)
  // Vacant flag
  const vacant = res.body.reps.find(r => r.slp_code === 34)
  assert.equal(vacant.is_vacant, true)
  assert.equal(vacant.provisional_phone, '09180000034')
})

test('admin_sap_reps_rejects_non_admin_session', async () => {
  const handler = buildEnv({ session: { id: 'tsr-uuid', role: 'tsr' } })
  const req = { method: 'GET', headers: {}, query: {} }
  const res = mockRes()
  await handler(req, res)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body.error, 'Admin access required')
})

test('admin_sap_reps_rejects_no_session', async () => {
  const handler = buildEnv({ session: null })
  const req = { method: 'GET', headers: {}, query: {} }
  const res = mockRes()
  await handler(req, res)
  assert.equal(res.statusCode, 401)
})

test('admin_sap_reps_links_existing_supabase_user_when_slpcode_matches', async () => {
  const handler = buildEnv({
    supabaseUsers: [
      { id: 'jefrey-uuid', name: 'Jefrey Gatchalian', role: 'dsm', phone: '09180000017',
        sap_slpcode: 17, manager_id: 'edfrey-uuid', is_active: true },
      { id: 'edfrey-uuid', name: 'Edfrey Buenaventura', role: 'rsm', phone: '09180000010',
        sap_slpcode: 10, manager_id: null, is_active: true }
    ]
  })
  const req = { method: 'GET', headers: {}, query: {} }
  const res = mockRes()
  await handler(req, res)
  assert.equal(res.statusCode, 200)

  const jefrey = res.body.reps.find(r => r.slp_code === 17)
  assert.ok(jefrey.linked_supabase_user, 'jefrey should be linked')
  assert.equal(jefrey.linked_supabase_user.id, 'jefrey-uuid')
  assert.equal(jefrey.linked_supabase_user.role, 'dsm')

  const abegail = res.body.reps.find(r => r.slp_code === 4)
  assert.equal(abegail.linked_supabase_user, null, 'abegail not yet onboarded')

  // Eligible managers dropdown must include edfrey (rsm) but NOT jefrey (dsm)
  const mgrIds = res.body.supabase_managers.map(m => m.id)
  assert.ok(mgrIds.includes('edfrey-uuid'))
  assert.ok(!mgrIds.includes('jefrey-uuid'))
})

test('admin_sap_reps_service_token_session_passes_admin_gate', async () => {
  const handler = buildEnv({
    session: { id: 'svc:patrol', role: 'service' },
    supabaseUsers: []
  })
  const req = { method: 'GET', headers: {}, query: {} }
  const res = mockRes()
  await handler(req, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.total_reps, 4)
})
