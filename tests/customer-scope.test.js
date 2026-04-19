// Unit tests for api/customer.js scope access control — exercised via node:test.
// Run: node --test tests/customer-scope.test.js   (or: npm test)
//
// Mocks ./_db, ./_auth, ./_scope, ./lib/customer-map, ../lib/cache via require.cache
// BEFORE requiring the handler so we never touch SAP / Supabase / the real pool.
// Tests the two acceptance contracts:
//   1. access_granted_when_in_scope  — customer exists, scope has a matching SlpCode
//      → handler returns 200 + full payload + scope.access_granted=true
//   2. 404_when_out_of_scope         — customer exists, scope has NO matching SlpCode
//      → handler returns 404 { error: 'Customer not found' }
// Plus 3 extra guards around edge cases (is_empty, scope=ALL, no scope param).

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const Module = require('module')

// ── Module-mock helper ─────────────────────────────────────────────────────
// Pre-populates require.cache so that when api/customer.js runs its top-level
// require(...) calls, our stubs are returned instead of the real modules.
function registerMock(requestingFile, relPath, exportsObj) {
  const resolved = Module._resolveFilename(relPath, {
    id: requestingFile, filename: requestingFile, paths: Module._nodeModulePaths(path.dirname(requestingFile))
  })
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, children: [], paths: [], exports: exportsObj }
  return resolved
}

function resetHandler() {
  // Fresh-require of customer.js each test so state (cache hits) doesn't leak.
  const customerPath = path.join(__dirname, '..', 'api', 'customer.js')
  delete require.cache[customerPath]
  return customerPath
}

function mockRes() {
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    status(code) { this.statusCode = code; return this },
    json(obj)    { this.body = obj; return this },
    end()        { return this }
  }
  return res
}

// ── Shared query-stub factory ──────────────────────────────────────────────
// Records every SQL call so tests can inspect what ran, AND returns a canned
// response based on a simple substring match on the SQL text.
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

// Canned OCRD/OINV/OSLP shape for "customer exists, has sales data"
function standardResponses() {
  return [
    ['SELECT 1 AS in_scope',                    [{ in_scope: 1 }]],                                    // pre-check — IN scope
    ['LEFT JOIN OSLP S ON T0.SlpCode',          [{ CardCode: 'CA000196', CardName: 'FALCOR MARKETING CORPORATION',
                                                   Phone1: '02-1234-5678', Phone2: null, Cellular: null,
                                                   email: 'test@test.ph', City: 'Manila', Address: '123 Main',
                                                   SlpCode: 12, rsm: 'JAN TORRE' }]],
    ['orders_count',                             [{ revenue: 111000000, volume_bags: 45000, volume: 2087.3, orders_count: 150 }]],
    ['DATEDIFF(DAY, T0.DocDueDate',              []],   // ar_invoices: none open
    ['T1.Dscription',                            []],   // product_breakdown
    ['SELECT TOP 10',                            []],   // recent_orders
    ['mtd_vol',                                  [{ mtd_vol: 550, mtd_sales: 25000000 }]],
    ['AS gm_ton FROM OINV',                      [{ gm_ton: 4280 }]],
    ['AS dso FROM OINV',                         [{ dso: 32 }]],
    ['MONTH(T0.DocDate)',                        []],   // cy_vs_ly raw
    ['age_days',                                 [{ age_days: 1200, create_date: '2023-01-01' }]],
    ['COUNT(*) + 1 AS rank_num',                 [{ rank_num: 3 }]]
  ]
}

// Shared stub modules (reset per-test below via resetHandler)
function buildEnv(scopeResolvedBy, queryStub) {
  const customerPath = resetHandler()
  const apiDir = path.join(__dirname, '..', 'api')

  // Stub _auth
  registerMock(customerPath, path.join(apiDir, '_auth.js'), {
    verifySession: async () => null,
    verifyServiceToken: async () => ({ id: 'svc:patrol', name: 'Patrol Service', role: 'service',
                                        region: 'ALL', district: 'ALL', territory: null, is_service: true })
  })

  // Stub _scope — scopeForUser returns whatever the test asked for
  registerMock(customerPath, path.join(apiDir, '_scope.js'), {
    scopeForUser: async (uuid) => scopeResolvedBy(uuid)
  })

  // Stub customer-map (toHistoricalCode returns null — skips historical query branch)
  registerMock(customerPath, path.join(apiDir, 'lib', 'customer-map.js'), {
    toHistoricalCode: async () => null,
    rekeyHistoricalRows: async (rows) => rows
  })

  // Stub _db
  registerMock(customerPath, path.join(apiDir, '_db.js'), {
    query: queryStub,
    queryH: async () => [],
    queryBoth: async () => []
  })

  // Stub cache (no-op — always miss)
  registerMock(customerPath, path.join(__dirname, '..', 'lib', 'cache.js'), {
    get: () => null,
    set: () => {}
  })

  // Now require the handler fresh — its top-level requires will get our stubs
  return require(customerPath)
}

// ─────────────────────────────────────────────────────────────────────────
// TEST 1 — Access granted when in scope
// ─────────────────────────────────────────────────────────────────────────
test('customer_access_granted_when_in_scope', async () => {
  const queryStub = makeQueryStub(standardResponses())
  const handler = buildEnv(
    async () => ({ userId: 'dsm-uuid', role: 'dsm', name: 'Jefrey',
                    slpCodes: [5, 12, 17], districtCodes: [10], is_empty: false }),
    queryStub
  )

  const req = {
    method: 'GET',
    headers: { authorization: 'Bearer TESTTOKEN' },
    query: { id: 'CA000196', scope: 'user:dsm-uuid' }
  }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.ok(res.body, 'response body present')
  assert.equal(res.body.info?.CardCode, 'CA000196')
  assert.equal(res.body.info?.CardName, 'FALCOR MARKETING CORPORATION')
  assert.ok(res.body.scope, 'scope meta present on scoped response')
  assert.equal(res.body.scope.access_granted, true)
  assert.equal(res.body.scope.is_empty, false)
  assert.equal(res.body.scope.role, 'dsm')

  // Verify access pre-check ran BEFORE main info query
  const sqls = queryStub.calls.map(c => c.sql)
  const preCheckIdx = sqls.findIndex(s => s.includes('SELECT 1 AS in_scope'))
  const infoIdx     = sqls.findIndex(s => s.includes('LEFT JOIN OSLP S ON T0.SlpCode'))
  assert.ok(preCheckIdx !== -1,   'pre-check query ran')
  assert.ok(infoIdx     !== -1,   'info query ran')
  assert.ok(preCheckIdx < infoIdx, 'pre-check ran before info query')
  // Pre-check SQL must include the scope's SlpCodes
  const preCheckSql = queryStub.calls[preCheckIdx].sql
  assert.ok(preCheckSql.includes('SlpCode IN (5,12,17)'), 'pre-check inlines SlpCodes')
  assert.ok(preCheckSql.includes("validFor = 'Y'"),       'pre-check checks validFor')
  assert.ok(preCheckSql.includes("NOT LIKE 'CE%'"),       'pre-check excludes CE%')
})

// ─────────────────────────────────────────────────────────────────────────
// TEST 2 — 404 when out of scope (scope resolves but CardCode doesn't match)
// ─────────────────────────────────────────────────────────────────────────
test('customer_404_when_out_of_scope', async () => {
  const responses = standardResponses()
  // Override pre-check to return empty — cardcode NOT in user's scope
  responses[0] = ['SELECT 1 AS in_scope', []]

  const queryStub = makeQueryStub(responses)
  const handler = buildEnv(
    async () => ({ userId: 'dsm-uuid', role: 'dsm', name: 'Jefrey',
                    slpCodes: [99], districtCodes: [], is_empty: false }),
    queryStub
  )

  const req = {
    method: 'GET',
    headers: { authorization: 'Bearer TESTTOKEN' },
    query: { id: 'CA000196', scope: 'user:dsm-uuid' }
  }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.body, { error: 'Customer not found' })

  // Main info query must NOT have run — 404 is returned before it
  const sqls = queryStub.calls.map(c => c.sql)
  assert.ok(!sqls.some(s => s.includes('LEFT JOIN OSLP S ON T0.SlpCode')),
            'info query did NOT run after access denied')
})

// ─────────────────────────────────────────────────────────────────────────
// TEST 3 — is_empty scope returns 404 without even running the pre-check
// ─────────────────────────────────────────────────────────────────────────
test('customer_404_when_scope_is_empty', async () => {
  const queryStub = makeQueryStub(standardResponses())
  const handler = buildEnv(
    async () => ({ userId: 'tsr-without-slp', role: 'tsr', name: 'Jake',
                    slpCodes: [], districtCodes: [], is_empty: true }),
    queryStub
  )

  const req = {
    method: 'GET',
    headers: { authorization: 'Bearer TESTTOKEN' },
    query: { id: 'CA000196', scope: 'user:tsr-without-slp' }
  }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 404)
  assert.deepEqual(res.body, { error: 'Customer not found' })
  // No SQL at all (not even pre-check) — guard short-circuits
  assert.equal(queryStub.calls.length, 0, 'zero SQL queries when scope is_empty')
})

// ─────────────────────────────────────────────────────────────────────────
// TEST 4 — exec scope (ALL) skips pre-check and returns full payload
// ─────────────────────────────────────────────────────────────────────────
test('customer_exec_scope_skips_precheck_and_returns_data', async () => {
  const queryStub = makeQueryStub(standardResponses())
  const handler = buildEnv(
    async () => ({ userId: 'mat-uuid', role: 'exec', name: 'Mathieu',
                    slpCodes: 'ALL', districtCodes: [], is_empty: false }),
    queryStub
  )

  const req = {
    method: 'GET',
    headers: { authorization: 'Bearer TESTTOKEN' },
    query: { id: 'CA000196', scope: 'user:mat-uuid' }
  }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.scope?.role, 'exec')
  assert.equal(res.body.scope?.access_granted, true)
  // Pre-check skipped for ALL scope
  const sqls = queryStub.calls.map(c => c.sql)
  assert.ok(!sqls.some(s => s.includes('SELECT 1 AS in_scope')),
            'pre-check skipped when scope is ALL')
})

// ─────────────────────────────────────────────────────────────────────────
// TEST 5 — no scope param on service-token call → unchanged behavior, no scope key
// ─────────────────────────────────────────────────────────────────────────
test('customer_no_scope_param_returns_data_without_scope_meta', async () => {
  const queryStub = makeQueryStub(standardResponses())
  const handler = buildEnv(
    async () => { throw new Error('scopeForUser should not be called when no scope param') },
    queryStub
  )

  const req = {
    method: 'GET',
    headers: { authorization: 'Bearer TESTTOKEN' },
    query: { id: 'CA000196' }    // no scope param
  }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.info?.CardCode, 'CA000196')
  assert.equal(res.body.scope, undefined, 'scope meta omitted on no-scope path')
})
