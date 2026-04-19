// Unit tests for api/ar.js scope-aware filtering — node:test.
// Run: node --test tests/ar-scope.test.js   (or: npm test)
//
// Mocks _db / _auth / _scope / ../lib/cache via require.cache pre-population.
// Uses the REAL buildScopeWhere helper so generated SQL is end-to-end correct.
// Covers:
//   1. ar_exec_sees_national_no_filter_sql   — scope=ALL → no EXISTS, CE% still added
//   2. ar_dsm_scope_filters_current_queries  — bounded scope → EXISTS in every
//      current-period SQL (5 queries), LY queryH stays unscoped
//   3. ar_empty_scope_returns_zero_payload   — is_empty → 200 skeleton, no SQL
//   4. ar_no_scope_param_omits_scope_meta    — session path byte-identical

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
  const p = path.join(__dirname, '..', 'api', 'ar.js')
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
function makeQueryHStub(rowsFn) {
  const calls = []
  const fn = async (sqlText, params) => {
    calls.push({ sql: sqlText.replace(/\s+/g, ' ').trim(), params })
    return rowsFn ? rowsFn(sqlText, params) : []
  }
  fn.calls = calls
  return fn
}

// Canned AR-shaped responses
function standardResponses() {
  return [
    ['active_with_ar',    [{ active_with_ar: 150, delinquent_with_ar: 20, inactive_with_ar: 5 }]],
    ['@ar_delinq',        [{ active_balance: 10000000, total_balance: 12000000, delinquent_balance: 2000000,
                              dso_active: 32, dso_total: 38 }]],
    ['current_amt',       [{ current_amt: 5000000, d1_30: 3000000, d31_60: 1500000, d61_90: 1000000,
                              d91_120: 500000, d121_365: 800000, over_1y: 200000 }]],
    ['ar_by_region',      [{ region: 'Luzon', ar: 7000000, sales_90d: 100000000, dso: 30 },
                            { region: 'Visayas', ar: 2500000, sales_90d: 45000000, dso: 28 },
                            { region: 'Mindanao', ar: 2500000, sales_90d: 40000000, dso: 35 }]],
    ['bp_status',         [{ CardCode: 'CA000196', CardName: 'FALCOR', bp_status: 'Active',
                              frozen_for: 'N', is_delinquent: 0, terms: '30 Days',
                              balance: 11100000, current_amt: 6770000, new_overdue: 0,
                              falling_due: 0, overdue: 4330000, days_overdue: 12, bucket: '1_30' }]],
    ['@ar_7d_ago',        [{ ar_7d_ago: 11500000, dso_7d_ago: 33 }]]
  ]
}

function buildEnv(scopeResolvedBy, queryStub, queryHStub, serviceAuth = true) {
  const arPath = resetHandler()
  const apiDir = path.join(__dirname, '..', 'api')
  const libDir = path.join(__dirname, '..', 'lib')

  registerMock(arPath, path.join(apiDir, '_auth.js'), {
    verifySession: async () => (serviceAuth ? null : {
      id: 'session-user', name: 'Test', role: 'exec',
      region: 'ALL', district: null, territory: null
    }),
    verifyServiceToken: async () => (serviceAuth ? {
      id: 'svc:patrol', name: 'Patrol Service', role: 'service',
      region: 'ALL', district: 'ALL', territory: null, is_service: true
    } : null),
    applyRoleFilter: (_s, w) => w
  })

  // Real buildScopeWhere so EXISTS SQL generation is covered end-to-end.
  const scopePath = path.join(apiDir, '_scope.js')
  delete require.cache[scopePath]
  const realScope = require(scopePath)
  registerMock(arPath, scopePath, {
    ...realScope,
    scopeForUser: async (uuid) => scopeResolvedBy(uuid)
  })

  registerMock(arPath, path.join(apiDir, '_db.js'), {
    query:  queryStub,
    queryH: queryHStub || makeQueryHStub(() => [{ ar_ly: 9500000, overdue_ly: 2000000 }])
  })

  registerMock(arPath, path.join(libDir, 'cache.js'), {
    get: () => null,
    set: () => {}
  })

  return require(arPath)
}

// ─────────────────────────────────────────────────────────────────────────
test('ar_exec_sees_national_no_filter_sql', async () => {
  const queryStub = makeQueryStub(standardResponses())
  const handler = buildEnv(
    async () => ({ userId: 'mat', role: 'exec', name: 'Mat',
                    slpCodes: 'ALL', districtCodes: [], is_empty: false }),
    queryStub
  )

  const req = { method: 'GET', headers: { authorization: 'Bearer T' },
                query: { scope: 'user:mat' } }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.ok(res.body.total_balance > 0,  'total_balance populated')
  assert.ok(res.body.clients.length > 0, 'clients populated')
  assert.equal(res.body.by_region.length, 3, 'all 3 regions present')
  assert.equal(res.body.scope?.role, 'exec')
  assert.equal(res.body.scope?.slpCodes_count, 'ALL')
  assert.equal(res.body.scope?.ly_unscoped, true)

  const sqls = queryStub.calls.map(c => c.sql)
  // ALL scope → defense-in-depth only (NO EXISTS scope filter with SlpCode IN clause)
  assert.ok(sqls.some(s => s.includes("NOT LIKE 'CE%'")),      'CE% exclusion present')
  assert.ok(sqls.some(s => s.includes('SlpCode <> 1')),        'SlpCode<>1 exclusion present')
  assert.ok(!sqls.some(s => /SlpCode IN \(\d+/.test(s)),       'no SlpCode IN list for ALL scope')
})

// ─────────────────────────────────────────────────────────────────────────
test('ar_dsm_scope_filters_current_queries_only', async () => {
  const queryStub  = makeQueryStub(standardResponses())
  const queryHStub = makeQueryHStub(() => [{ ar_ly: 9500000, overdue_ly: 2000000 }])
  const handler = buildEnv(
    async () => ({ userId: 'jefrey', role: 'dsm', name: 'Jefrey',
                    slpCodes: [5, 17], districtCodes: [10], is_empty: false }),
    queryStub, queryHStub
  )

  const req = { method: 'GET', headers: { authorization: 'Bearer T' },
                query: { scope: 'user:jefrey' } }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.scope?.role, 'dsm')
  assert.equal(res.body.scope?.slpCodes_count, 2)
  assert.equal(res.body.scope?.ly_unscoped, true)
  assert.equal(res.body.ar_ly, 9500000, 'LY still populated despite scope')

  const sqls = queryStub.calls.map(c => c.sql)
  // All 5 current-period queries need SlpCode IN (5,17)
  const needles = ['active_with_ar', '@ar_delinq', 'current_amt', 'ar_by_region', 'bp_status', '@ar_7d_ago']
  for (const needle of needles) {
    const q = sqls.find(s => s.includes(needle))
    assert.ok(q, `query ${needle} ran`)
    assert.ok(q.includes('SlpCode IN (5,17)'),
              `query ${needle} has scope SlpCode list`)
  }

  // LY historical query (queryH) ran UNSCOPED — no SlpCode filter applied to it
  const hSqls = queryHStub.calls.map(c => c.sql)
  assert.ok(hSqls.length > 0, 'queryH (LY snapshot) executed')
  assert.ok(!hSqls.some(s => /SlpCode IN \(\d+/.test(s)),
            'LY historical query stays unscoped')
})

// ─────────────────────────────────────────────────────────────────────────
test('ar_empty_scope_returns_zero_payload_no_sql', async () => {
  const queryStub  = makeQueryStub(standardResponses())
  const queryHStub = makeQueryHStub(() => [{ ar_ly: 9500000 }])
  const handler = buildEnv(
    async () => ({ userId: 'jake', role: 'tsr', name: 'Jake',
                    slpCodes: [], districtCodes: [], is_empty: true }),
    queryStub, queryHStub
  )

  const req = { method: 'GET', headers: { authorization: 'Bearer T' },
                query: { scope: 'user:jake' } }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.total_balance, 0)
  assert.equal(res.body.dso, 0)
  assert.deepEqual(res.body.clients, [])
  assert.deepEqual(res.body.by_region, [])
  assert.deepEqual(res.body.buckets, { current: 0, d1_30: 0, d31_60: 0, d61_90: 0,
                                        d91_120: 0, d121_365: 0, over_1y: 0 })
  assert.equal(res.body.scope?.is_empty, true)
  assert.equal(res.body.scope?.role, 'tsr')
  assert.equal(res.body.scope?.ly_unscoped, true)

  // Early return → zero SQL queries (no `query()` AND no `queryH()`)
  assert.equal(queryStub.calls.length,  0, 'no current-period SQL on empty scope')
  assert.equal(queryHStub.calls.length, 0, 'no LY query on empty scope')
})

// ─────────────────────────────────────────────────────────────────────────
test('ar_no_scope_param_omits_scope_meta', async () => {
  const queryStub = makeQueryStub(standardResponses())
  const handler = buildEnv(
    async () => { throw new Error('scopeForUser should not be called without scope param') },
    queryStub, undefined, false   // session auth
  )

  const req = { method: 'GET', headers: { 'x-session-id': 'session-user' }, query: {} }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.scope, undefined, 'scope key omitted on no-scope path')
  assert.ok(res.body.total_balance > 0, 'data still populated')
  assert.ok(res.body.clients.length > 0)
  assert.equal(res.body.by_region.length, 3)

  // Unscoped path still hardened: CE% + SlpCode<>1 everywhere
  const sqls = queryStub.calls.map(c => c.sql)
  assert.ok(sqls.some(s => s.includes("NOT LIKE 'CE%'")), 'CE% exclusion even on session path')
  assert.ok(sqls.some(s => s.includes('SlpCode <> 1')),   'SlpCode<>1 exclusion even on session path')
  assert.ok(!sqls.some(s => /SlpCode IN \(\d+/.test(s)),  'no SlpCode IN list without scope')
})
