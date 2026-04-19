// Unit tests for api/speed.js scope-aware filtering — node:test.
// Run: node --test tests/speed-scope.test.js   (or: npm test)
//
// Mocks _db / _auth / _scope / ../lib/cache via require.cache pre-population.
// Covers the locked design decision: ODLN.SlpCode IN (...) direct attribution,
// NOT OCRD EXISTS. Speed uses a local buildSpeedScopeFilter (not _scope's
// buildScopeWhere) because ODLN lacks U_districtName and needs a different
// shape than OCRD-based endpoints.

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
  const p = path.join(__dirname, '..', 'api', 'speed.js')
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

// Canned ODLN-derived responses — same dataset used across tests.
// Needles MUST be unique per query — `ISO_WEEK` collides between QTD-daily
// and weekly_raw, so we use more specific signatures.
function standardResponses() {
  return [
    // totalRow
    ['AS actual_mt',            [{ actual_mt: 500 }]],
    // daily MTD/7D (else branch — includes DATENAME(WEEKDAY))
    ['DATENAME(WEEKDAY',        [{ ship_date: '2026-04-18', day_name: 'Saturday', daily_mt: 120 },
                                   { ship_date: '2026-04-17', day_name: 'Friday',   daily_mt: 180 }]],
    // daily YTD
    ["FORMAT(T0.DocDate, 'yyyy-MM')", [{ ship_date: '2026-04', day_name: 'Month', daily_mt: 500 }]],
    // daily QTD — needle: 'Week' AS day_name (literal string only in QTD)
    ["'Week'",                  [{ ship_date: 'W16', day_name: 'Week', daily_mt: 500 }]],
    // plant_breakdown — 'AS mtd' with trailing space distinguishes from 'mtd_actual'
    ['AS mtd ',                 [{ plant: 'AC', mtd: 200 }, { plant: 'HOREB', mtd: 300 }]],
    // rsm_speed
    ['AS rsm',                  [{ rsm: 'JAN TORRE', current_vol: 400 }]],
    // feed_type_speed
    ['AS brand',                [{ brand: 'VIEPRO HOG', current_vol: 300 }]],
    // weekly_raw — 'AS vol' is unique (no other query returns a vol column)
    ['AS vol',                  [{ week: 'W15', plant: 'AC', vol: 100 },
                                   { week: 'W16', plant: 'AC', vol: 200 }]],
    // lastMonthRow
    ['AS mt_full',              [{ mt_full: 400, mt_to_same_day: 300 }]],
    // priorRow — 'AS mt' with trailing space (won't match mt_full/mt_to_same_day)
    ['AS mt ',                  [{ mt: 350 }]]
  ]
}

function buildEnv(scopeResolvedBy, queryStub, serviceAuth = true) {
  const speedPath = resetHandler()
  const apiDir = path.join(__dirname, '..', 'api')
  const libDir = path.join(__dirname, '..', 'lib')

  registerMock(speedPath, path.join(apiDir, '_auth.js'), {
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

  registerMock(speedPath, path.join(apiDir, '_scope.js'), {
    scopeForUser: async (uuid) => scopeResolvedBy(uuid),
    buildScopeWhere: () => ({ sql: '', isEmpty: false })   // not used by speed
  })

  registerMock(speedPath, path.join(apiDir, '_db.js'), {
    query: queryStub,
    queryH: async () => [],
    queryBoth: async () => [],
    queryDateRange: async () => []
  })

  registerMock(speedPath, path.join(libDir, 'cache.js'), {
    get: () => null,
    set: () => {}
  })

  return require(speedPath)
}

// Helper to assert no NaN / Infinity in a number-only field tree
function assertNoNaN(obj, pathStr = '') {
  if (obj == null) return
  if (typeof obj === 'number') {
    assert.ok(Number.isFinite(obj), `${pathStr} is NaN/Infinity: ${obj}`)
    return
  }
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => assertNoNaN(v, `${pathStr}[${i}]`))
    return
  }
  if (typeof obj === 'object') {
    for (const k of Object.keys(obj)) assertNoNaN(obj[k], pathStr ? `${pathStr}.${k}` : k)
  }
}

// ─────────────────────────────────────────────────────────────────────────
test('speed_exec_sees_national_no_filter_sql', async () => {
  const queryStub = makeQueryStub(standardResponses())
  const handler = buildEnv(
    async () => ({ userId: 'mat', role: 'exec', name: 'Mat',
                    slpCodes: 'ALL', districtCodes: [], is_empty: false }),
    queryStub
  )

  const req = { method: 'GET', headers: { authorization: 'Bearer T' },
                query: { period: 'MTD', scope: 'user:mat' } }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.ok(res.body.period_volume_mt > 0, 'volume populated')
  assert.ok(res.body.daily.length > 0,     'daily populated')
  assert.ok(res.body.rsm_speed.length > 0, 'rsm_speed populated')
  assert.equal(res.body.scope?.role, 'exec')
  assert.equal(res.body.scope?.slpCodes_count, 'ALL')
  assert.equal(res.body.scope?.attribution, 'ODLN.SlpCode')

  const sqls = queryStub.calls.map(c => c.sql)
  assert.ok(!sqls.some(s => /SlpCode IN \(\d+/.test(s)),
            'no SlpCode IN list when scope is ALL')
  assertNoNaN(res.body)
})

// ─────────────────────────────────────────────────────────────────────────
test('speed_dsm_scope_filters_odln_slpcode_in_all_queries', async () => {
  const queryStub = makeQueryStub(standardResponses())
  const handler = buildEnv(
    async () => ({ userId: 'jefrey', role: 'dsm', name: 'Jefrey',
                    slpCodes: [5, 17], districtCodes: [10], is_empty: false }),
    queryStub
  )

  const req = { method: 'GET', headers: { authorization: 'Bearer T' },
                query: { period: 'MTD', scope: 'user:jefrey' } }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.scope?.role, 'dsm')
  assert.equal(res.body.scope?.slpCodes_count, 2)
  assert.equal(res.body.scope?.attribution, 'ODLN.SlpCode')

  // EVERY ODLN query must carry the scope filter — 10 sites total (totalRow,
  // daily-else, plant_breakdown, rsm_speed, feed_type_speed, weekly_raw,
  // lastMonthRow, priorRow) — MTD period runs only one daily branch.
  const sqls = queryStub.calls.map(c => c.sql)
  const needles = [
    'AS actual_mt',                     // totalRow
    'DATENAME(WEEKDAY',                 // daily (MTD branch)
    'AS mtd ',                          // plant_breakdown
    'AS rsm',                           // rsm_speed
    'AS brand',                         // feed_type_speed
    'AS week',                          // weekly_raw
    'AS mt_full',                       // lastMonthRow
    'AS mt '                            // priorRow
  ]
  for (const needle of needles) {
    const q = sqls.find(s => s.includes(needle))
    assert.ok(q, `query with needle ${JSON.stringify(needle)} ran`)
    assert.ok(q.includes('T0.SlpCode IN (5,17)'),
              `query ${needle} has T0.SlpCode IN (5,17)`)
  }
  assertNoNaN(res.body)
})

// ─────────────────────────────────────────────────────────────────────────
test('speed_empty_scope_returns_zero_payload_no_sql', async () => {
  const queryStub = makeQueryStub(standardResponses())
  const handler = buildEnv(
    async () => ({ userId: 'jake', role: 'tsr', name: 'Jake',
                    slpCodes: [], districtCodes: [], is_empty: true }),
    queryStub
  )

  const req = { method: 'GET', headers: { authorization: 'Bearer T' },
                query: { period: 'MTD', scope: 'user:jake' } }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.period_volume_mt, 0)
  assert.equal(res.body.daily_pullout, 0)
  assert.equal(res.body.projected_period_volume, 0)
  assert.equal(res.body.vs_prior_period_pct, 0)
  assert.equal(res.body.vs_last_month_pct, 0)
  assert.deepEqual(res.body.daily, [])
  assert.deepEqual(res.body.plant_breakdown, [])
  assert.deepEqual(res.body.rsm_speed, [])
  assert.deepEqual(res.body.weekly_matrix, { weeks: [], plants: [], grid: [] })
  assert.equal(res.body.scope?.is_empty, true)
  assert.equal(res.body.scope?.attribution, 'ODLN.SlpCode')
  assert.equal(queryStub.calls.length, 0, 'no SQL on empty scope')
  assertNoNaN(res.body)
})

// ─────────────────────────────────────────────────────────────────────────
test('speed_no_scope_param_omits_scope_meta', async () => {
  const queryStub = makeQueryStub(standardResponses())
  const handler = buildEnv(
    async () => { throw new Error('scopeForUser should not be called without scope param') },
    queryStub, false
  )

  const req = { method: 'GET', headers: { 'x-session-id': 'session-user' },
                query: { period: 'MTD' } }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.scope, undefined, 'scope key omitted on no-scope path')
  assert.ok(res.body.period_volume_mt > 0, 'data populated')
  const sqls = queryStub.calls.map(c => c.sql)
  assert.ok(!sqls.some(s => /SlpCode IN \(\d+/.test(s)),
            'no SlpCode IN list without scope')
  assertNoNaN(res.body)
})

// ─────────────────────────────────────────────────────────────────────────
test('speed_division_by_zero_returns_zero_not_nan', async () => {
  // Scoped DSM with zero deliveries — all aggregates return 0, math guards
  // must prevent NaN/Infinity from leaking into any percentage / rate field.
  const zeroResponses = [
    ['AS actual_mt',            [{ actual_mt: 0 }]],
    ['DATENAME(WEEKDAY',        []],
    ["'Week'",                  []],
    ['AS mtd ',                 []],
    ['AS rsm',                  []],
    ['AS brand',                []],
    ['AS vol',                  []],
    ['AS mt_full',              [{ mt_full: 0, mt_to_same_day: 0 }]],
    ['AS mt ',                  [{ mt: 0 }]]
  ]
  const queryStub = makeQueryStub(zeroResponses)
  const handler = buildEnv(
    async () => ({ userId: 'dsm-zero', role: 'dsm',
                    slpCodes: [999], districtCodes: [], is_empty: false }),
    queryStub
  )

  const req = { method: 'GET', headers: { authorization: 'Bearer T' },
                query: { period: 'MTD', scope: 'user:dsm-zero' } }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  // Division-by-zero guards must produce 0, never NaN/Infinity
  assertNoNaN(res.body)
  assert.equal(res.body.daily_pullout, 0)
  assert.equal(res.body.projected_period_volume, 0)
  assert.equal(res.body.pct_of_target, 0)
  assert.equal(res.body.vs_prior_period_pct, 0)
  assert.equal(res.body.vs_last_month_pct, 0)
  // Scope still reports correctly even with zero data
  assert.equal(res.body.scope?.is_empty, false, 'is_empty is false — scope has SlpCodes')
  assert.equal(res.body.scope?.attribution, 'ODLN.SlpCode')
})
