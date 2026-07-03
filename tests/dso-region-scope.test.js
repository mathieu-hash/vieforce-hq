// Unit tests for hero DSO region scoping — api/ar.js + api/dashboard.js (node:test).
// Run: node --test tests/dso-region-scope.test.js   (or: npm test)
//
// Residual-DSO fix (audit 2026-06-06 / WP5): under a region filter the hero
// dso_active/dso_total must use the line-apportioned by_region methodology
// (regionCaseSql on the INV1 line), NOT the EXISTS whole-invoice scoping that
// dilutes the ratio toward national. region=ALL must keep the original SQL
// (no region predicate, no INV1 line join in the DSO declares).

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const Module = require('module')

const apiDir = path.join(__dirname, '..', 'api')
const libDir = path.join(__dirname, '..', 'lib')

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

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    status(code) { this.statusCode = code; return this },
    json(obj)    { this.body = obj; return this },
    end()        { return this }
  }
}

function makeQueryStub() {
  const calls = []
  const fn = async (sqlText, params) => {
    calls.push({ sql: sqlText, params })
    return []
  }
  fn.calls = calls
  return fn
}

// ───────────────────────────── api/ar.js ─────────────────────────────
function buildArHandler(queryStub) {
  const arPath = path.join(apiDir, 'ar.js')
  delete require.cache[arPath]
  registerMock(arPath, path.join(apiDir, '_auth.js'), {
    verifySession: async () => ({ id: 'u1', name: 'Exec', role: 'exec', region: 'ALL' }),
    verifyServiceToken: async () => null
  })
  registerMock(arPath, path.join(apiDir, '_scope.js'), {
    scopeForUser: async () => null,
    resolveRequestScope: async () => null,
    buildScopeWhere: () => ({ sql: '' })
  })
  registerMock(arPath, path.join(apiDir, '_db.js'), {
    query: queryStub,
    queryH: async () => [{ ar_ly: 0, overdue_ly: 0 }]
  })
  registerMock(arPath, path.join(libDir, 'cache.js'), { get: () => null, set: () => {}, keyableUrl: (u) => u })
  return require(arPath)
}

test('ar_dso_region_filter_uses_line_apportioned_sql', async () => {
  const queryStub = makeQueryStub()
  const handler = buildArHandler(queryStub)
  const res = mockRes()
  await handler({ method: 'GET', headers: { 'x-session-id': 'u1' }, query: { region: 'Visayas' } }, res)
  assert.equal(res.statusCode, 200)

  const dsoSql = queryStub.calls.map(c => c.sql).find(s => s.includes('@ar_delinq'))
  assert.ok(dsoSql, 'AR+DSO query ran')
  // Apportioned declares present and feed the dso selects
  assert.ok(dsoSql.includes('@dso_ar_active'), 'apportioned AR numerator declared')
  assert.ok(dsoSql.includes('@dso_s90_active'), 'apportioned 90d denominator declared')
  assert.ok(dsoSql.includes('LineTotal * (O.DocTotal - O.PaidToDate)'), 'AR apportioned by line share')
  assert.ok(/INNER JOIN INV1 L ON L\.DocEntry = O\.DocEntry/.test(dsoSql), 'INV1 line join present')
  assert.ok(/L\.WhsCode IN \('HOREB','HBEXT','HBEXT-QA','BAC','ARGAO'\)/.test(dsoSql), 'regionCaseSql on the line alias')
  assert.ok(/@dso_ar_active \/ \(@dso_s90_active\/90\.0\)[\s\S]*AS dso_active/.test(dsoSql),
            'dso_active computed from apportioned pair')
  assert.ok(/@dso_ar_total \/ \(@dso_s90_total\/90\.0\)[\s\S]*AS dso_total/.test(dsoSql),
            'dso_total computed from apportioned pair')
  assert.equal(queryStub.calls.find(c => c.sql.includes('@ar_delinq')).params.region, 'Visayas')

  // 7-day comparison block scoped too (was fully national before this fix)
  const cmpSql = queryStub.calls.map(c => c.sql).find(s => s.includes('@ar_7d_ago'))
  assert.ok(cmpSql, 'comparison query ran')
  assert.ok(cmpSql.includes('EXISTS (SELECT 1 FROM INV1 L'), 'ar_7d_ago region-scoped (EXISTS, like balances)')
  assert.ok(cmpSql.includes('@dso_ar_7d'), 'dso_7d_ago apportioned numerator declared')
  assert.ok(/@dso_ar_7d \/ \(@dso_s90_7d\/90\.0\)[\s\S]*AS dso_7d_ago/.test(cmpSql),
            'dso_7d_ago computed from apportioned pair')
})

test('ar_dso_region_all_keeps_original_sql', async () => {
  const queryStub = makeQueryStub()
  const handler = buildArHandler(queryStub)
  const res = mockRes()
  await handler({ method: 'GET', headers: { 'x-session-id': 'u1' }, query: { region: 'ALL' } }, res)
  assert.equal(res.statusCode, 200)

  const dsoSql = queryStub.calls.map(c => c.sql).find(s => s.includes('@ar_delinq'))
  assert.ok(dsoSql, 'AR+DSO query ran')
  assert.ok(!dsoSql.includes('@dso_'), 'no apportioned declares for ALL')
  assert.ok(!dsoSql.includes('@region'), 'no region predicate for ALL')
  assert.ok(/@ar_active \/ \(@sales_90d_active\/90\.0\)[\s\S]*AS dso_active/.test(dsoSql),
            'dso_active uses the original national pair')

  const cmpSql = queryStub.calls.map(c => c.sql).find(s => s.includes('@ar_7d_ago'))
  assert.ok(cmpSql, 'comparison query ran')
  assert.ok(!cmpSql.includes('@dso_'), 'comparison has no apportioned declares for ALL')
  assert.ok(!cmpSql.includes('@region'), 'comparison has no region predicate for ALL')
})

// ─────────────────────────── api/dashboard.js ───────────────────────────
function buildDashboardHandler(queryStub) {
  const dashPath = path.join(apiDir, 'dashboard.js')
  delete require.cache[dashPath]
  registerMock(dashPath, path.join(apiDir, '_auth.js'), {
    verifySession: async () => ({ id: 'u1', name: 'Exec', role: 'exec', region: 'ALL' }),
    getPeriodDates: () => ({ dateFrom: new Date(2026, 4, 1), dateTo: new Date(2026, 4, 31) }),
    applyRoleFilter: (_s, w) => w
  })
  registerMock(dashPath, path.join(apiDir, '_db.js'), {
    query: queryStub,
    queryBoth: async () => [],
    queryDateRange: async () => []
  })
  registerMock(dashPath, path.join(libDir, 'cache.js'), { get: () => null, set: () => {} })
  return require(dashPath)
}

test('dashboard_dso_region_filter_uses_line_apportioned_sql', async () => {
  const queryStub = makeQueryStub()
  const handler = buildDashboardHandler(queryStub)
  const res = mockRes()
  await handler({ method: 'GET', headers: { 'x-session-id': 'u1' },
                  query: { period: 'MTD', region: 'Visayas' } }, res)
  assert.equal(res.statusCode, 200)

  const dsoSql = queryStub.calls.map(c => c.sql).find(s => s.includes('@s90_active'))
  assert.ok(dsoSql, 'DSO query ran')
  assert.ok(dsoSql.includes('LineTotal * (O.DocTotal - O.PaidToDate)'), 'AR apportioned by line share')
  assert.ok(/INNER JOIN INV1 L ON L\.DocEntry = O\.DocEntry/.test(dsoSql), 'INV1 line join present')
  assert.ok(/L\.WhsCode IN \('HOREB','HBEXT','HBEXT-QA','BAC','ARGAO'\)/.test(dsoSql), 'regionCaseSql on the line alias')
  assert.ok(!dsoSql.includes('EXISTS (SELECT 1 FROM INV1'), 'EXISTS whole-invoice scoping replaced')
  assert.equal(queryStub.calls.find(c => c.sql.includes('@s90_active')).params.region, 'Visayas')

  // ar_balance keeps the EXISTS narrowing (unchanged behavior)
  const arSql = queryStub.calls.map(c => c.sql).find(s => s.includes('AS total_balance'))
  assert.ok(arSql, 'AR balance query ran')
  assert.ok(arSql.includes('EXISTS (SELECT 1 FROM INV1 L'), 'ar_balance still EXISTS-scoped')
})

test('dashboard_dso_region_all_keeps_original_sql', async () => {
  const queryStub = makeQueryStub()
  const handler = buildDashboardHandler(queryStub)
  const res = mockRes()
  await handler({ method: 'GET', headers: { 'x-session-id': 'u1' },
                  query: { period: 'MTD', region: 'ALL' } }, res)
  assert.equal(res.statusCode, 200)

  const dsoSql = queryStub.calls.map(c => c.sql).find(s => s.includes('@s90_active'))
  assert.ok(dsoSql, 'DSO query ran')
  assert.ok(!dsoSql.includes('INNER JOIN INV1'), 'no line join for ALL')
  assert.ok(!dsoSql.includes('@region'), 'no region predicate for ALL')
  assert.ok(dsoSql.includes('SUM(O.DocTotal - O.PaidToDate)'), 'original header-level sums kept')
})
