// Unit tests for api/customers.js scope-aware filtering — node:test.
// Run: node --test tests/customers-scope.test.js  (or: npm test)
//
// Mocks _db / _auth / _scope / lib/non-customer-codes / lib/customer-map /
// ../lib/cache via require.cache pre-population. No network, no SAP, no Supabase.
// Covers:
//   1. exec_sees_all_customers         — scope='ALL' → no EXISTS filter SQL added
//   2. dsm_scope_filters_to_team       — scope.slpCodes=[...] → EXISTS filter in SQL
//   3. empty_scope_returns_empty_list  — is_empty → early-return 200 zero-state, no SQL
//   4. no_scope_param_omits_scope_meta — session path byte-identical to pre-migration

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
  const p = path.join(__dirname, '..', 'api', 'customers.js')
  delete require.cache[p]
  return p
}

function mockRes() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    status(code) { this.statusCode = code; return this },
    json(obj)    { this.body = obj; return this },
    end()        { return this }
  }
}

function makeQueryStub(responses) {
  const calls = []
  const fn = async (sqlText, params) => {
    calls.push({ sql: sqlText.replace(/\s+/g, ' ').trim(), params })
    for (const [needle, rows] of responses) {
      if (sqlText.includes(needle)) return typeof rows === 'function' ? rows(params) : rows
    }
    return []
  }
  fn.calls = calls
  return fn
}

// Canned OCRD row + count — "data exists"
function standardResponses() {
  return [
    ['SELECT COUNT(*) AS total',  [{ total: 1382 }]],
    ['WITH CustomerYTD AS', [{
      CardCode: 'CA000196', CardName: 'FALCOR MARKETING CORPORATION',
      Phone1: '02-xxx', City: 'Manila', bp_status: 'Active', frozen_for: 'N',
      rsm: 'JAN TORRE', ytd_revenue: 111238710, ytd_bags: 45445,
      ytd_volume: 2087.275, ytd_gm_ton: 4279.82,
      last_order_date: '2026-02-18', region: 'Luzon', bu: 'DIST', status: 'Active'
    }]]
  ]
}

function buildEnv(scopeResolvedBy, queryStub, serviceAuth = true) {
  const customersPath = resetHandler()
  const apiDir = path.join(__dirname, '..', 'api')
  const libDir = path.join(__dirname, '..', 'lib')

  registerMock(customersPath, path.join(apiDir, '_auth.js'), {
    verifySession: async () => (serviceAuth ? null : {
      id: 'session-user', name: 'Test User', role: 'exec',
      region: 'ALL', district: null, territory: null
    }),
    verifyServiceToken: async () => (serviceAuth ? {
      id: 'svc:patrol', name: 'Patrol Service', role: 'service',
      region: 'ALL', district: 'ALL', territory: null, is_service: true
    } : null),
    applyRoleFilter: (_session, baseWhere) => baseWhere
  })

  // Use REAL _scope (for buildScopeWhere) but stub scopeForUser to resolve
  // to whatever the test asked for. Fresh-require to avoid cache carry-over.
  const scopePath = path.join(apiDir, '_scope.js')
  delete require.cache[scopePath]
  const realScope = require(scopePath)
  registerMock(customersPath, scopePath, {
    ...realScope,
    scopeForUser: async (uuid) => scopeResolvedBy(uuid)
  })

  registerMock(customersPath, path.join(apiDir, 'lib', 'non-customer-codes.js'), {
    isNonCustomerRow: () => false    // pass everything through
  })
  registerMock(customersPath, path.join(apiDir, 'lib', 'customer-map.js'), {
    rekeyHistoricalRows: async (rows) => rows,
    toHistoricalCode: async () => null
  })

  registerMock(customersPath, path.join(apiDir, '_db.js'), {
    query: queryStub,
    queryH: async () => []   // LY + rank helpers get empty arrays — fine for the tests
  })

  registerMock(customersPath, path.join(libDir, 'cache.js'), {
    get: () => null,
    set: () => {}
  })

  return require(customersPath)
}

// ─────────────────────────────────────────────────────────────────────────
test('customers_exec_sees_all_customers_no_filter_sql', async () => {
  const queryStub = makeQueryStub(standardResponses())
  const handler = buildEnv(
    async () => ({ userId: 'mat', role: 'exec', name: 'Mathieu',
                    slpCodes: 'ALL', districtCodes: [], is_empty: false }),
    queryStub
  )

  const req = {
    method: 'GET',
    headers: { authorization: 'Bearer TESTTOKEN' },
    query: { limit: '5', scope: 'user:mat' }
  }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.customers.length, 1)
  assert.equal(res.body.customers[0].CardCode, 'CA000196')
  assert.equal(res.body.total, 1382)
  assert.equal(res.body.scope?.role, 'exec')
  assert.equal(res.body.scope?.slpCodes_count, 'ALL')
  assert.equal(res.body.scope?.is_empty, false)

  // No EXISTS filter in SQL for ALL scope — but CE% + SlpCode=1 exclusions present
  const sqls = queryStub.calls.map(c => c.sql)
  assert.ok(sqls.some(s => s.includes("NOT LIKE 'CE%'")), 'CE% exclusion present')
  assert.ok(sqls.some(s => s.includes('SlpCode <> 1')),   'SlpCode=1 exclusion present')
  assert.ok(!sqls.some(s => s.includes('EXISTS (SELECT 1 FROM OCRD SC')),
            'no EXISTS scope filter when scope is ALL')
})

// ─────────────────────────────────────────────────────────────────────────
test('customers_dsm_scope_filters_to_team_slpcodes', async () => {
  const queryStub = makeQueryStub(standardResponses())
  const handler = buildEnv(
    async () => ({ userId: 'jefrey', role: 'dsm', name: 'Jefrey',
                    slpCodes: [5, 12, 17], districtCodes: [10], is_empty: false }),
    queryStub
  )

  const req = {
    method: 'GET',
    headers: { authorization: 'Bearer TESTTOKEN' },
    query: { limit: '5', scope: 'user:jefrey' }
  }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.scope?.role, 'dsm')
  assert.equal(res.body.scope?.slpCodes_count, 3)

  // EXISTS filter MUST be in both main + count queries, with integer-inlined SlpCodes
  const sqls = queryStub.calls.map(c => c.sql)
  const main  = sqls.find(s => s.includes('WITH CustomerYTD AS'))
  const count = sqls.find(s => s.includes('SELECT COUNT(*) AS total'))
  assert.ok(main,  'main query ran')
  assert.ok(count, 'count query ran')
  assert.ok(main.includes('SlpCode IN (5,12,17)'),  'main query has SlpCode list')
  assert.ok(count.includes('SlpCode IN (5,12,17)'), 'count query has SlpCode list')
  assert.ok(main.includes('U_districtName IN (10)'), 'district filter present')
})

// ─────────────────────────────────────────────────────────────────────────
test('customers_empty_scope_returns_empty_list_no_sql', async () => {
  const queryStub = makeQueryStub(standardResponses())
  const handler = buildEnv(
    async () => ({ userId: 'jake', role: 'tsr', name: 'Jake',
                    slpCodes: [], districtCodes: [], is_empty: true }),
    queryStub
  )

  const req = {
    method: 'GET',
    headers: { authorization: 'Bearer TESTTOKEN' },
    query: { limit: '5', scope: 'user:jake' }
  }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.body.customers, [])
  assert.equal(res.body.total, 0)
  assert.equal(res.body.pages, 0)
  assert.equal(res.body.limit, 5)
  assert.equal(res.body.non_customer_excluded, 0)
  assert.equal(res.body.scope?.is_empty, true)
  assert.equal(res.body.scope?.role, 'tsr')
  // Early return — zero SQL queries hit
  assert.equal(queryStub.calls.length, 0, 'no SQL executed on empty scope')
})

// ─────────────────────────────────────────────────────────────────────────
test('customers_no_scope_param_omits_scope_meta', async () => {
  const queryStub = makeQueryStub(standardResponses())
  const handler = buildEnv(
    async () => { throw new Error('scopeForUser should not be called without scope param') },
    queryStub,
    false   // session auth, not service
  )

  const req = {
    method: 'GET',
    headers: { 'x-session-id': 'session-user' },
    query: { limit: '5' }
  }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.scope, undefined, 'scope key omitted on no-scope path')
  assert.equal(res.body.customers.length, 1)
  assert.equal(res.body.total, 1382)

  // Unscoped path still has CE%/SlpCode=1 hardening (defense in depth)
  const sqls = queryStub.calls.map(c => c.sql)
  assert.ok(sqls.some(s => s.includes("NOT LIKE 'CE%'")), 'CE% exclusion even on session path')
  assert.ok(!sqls.some(s => s.includes('EXISTS (SELECT 1 FROM OCRD SC')),
            'no EXISTS when no scope param')
})
