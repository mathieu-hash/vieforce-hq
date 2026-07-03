// Unit tests for pending-PO open-quantity fix — api/sales.js + api/dashboard.js (node:test).
// Run: node --test tests/pending-po-openqty.test.js   (or: npm test)
//
// Data-accuracy fix (audit 2026-06-07): pending PO must aggregate the OPEN
// residual of open sales-order lines (RDR1.OpenQty, LineStatus='O'), not the
// full ordered Quantity/LineTotal (which double-counts already-delivered
// portions), and sales.js must not truncate aggregates to the 200 oldest
// lines (old TOP 200). Verified vs live SAP: 3,585.3 MT / ₱125.7M / 331 orders.

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

// ───────────────────────────── api/sales.js ─────────────────────────────
function buildSalesHandler(queryStub) {
  const salesPath = path.join(apiDir, 'sales.js')
  delete require.cache[salesPath]
  registerMock(salesPath, path.join(apiDir, '_auth.js'), {
    verifySession: async () => ({ id: 'u1', name: 'Exec', role: 'exec', region: 'ALL' }),
    verifyServiceToken: async () => null,
    getPeriodDates: () => ({ dateFrom: new Date(2026, 4, 1), dateTo: new Date(2026, 4, 31) }),
    applyRoleFilter: (_s, w) => w
  })
  registerMock(salesPath, path.join(apiDir, '_scope.js'), {
    scopeForUser: async () => null,
    resolveRequestScope: async () => null,
    buildScopeWhere: () => ({ sql: '', isEmpty: false }),
    emptySalesPayload: () => ({}),
    scopeResponseMeta: () => ({})
  })
  registerMock(salesPath, path.join(apiDir, '_db.js'), {
    query: queryStub,
    queryBoth: async () => [],
    queryDateRange: async () => []
  })
  registerMock(salesPath, path.join(libDir, 'cache.js'), { get: () => null, set: () => {} })
  return require(salesPath)
}

test('sales_pending_po_uses_openqty_open_lines_no_top200', async () => {
  const queryStub = makeQueryStub()
  const handler = buildSalesHandler(queryStub)
  const res = mockRes()
  await handler({ method: 'GET', headers: { 'x-session-id': 'u1' }, query: { period: 'MTD' } }, res)
  assert.equal(res.statusCode, 200)

  const poSql = queryStub.calls.map(c => c.sql).find(s => s.includes('FROM ORDR'))
  assert.ok(poSql, 'pending PO query ran')
  assert.ok(!poSql.includes('TOP 200'), 'TOP 200 truncation removed')
  assert.ok(poSql.includes('TOP 5000'), 'TOP 5000 payload guard present')
  assert.ok(/T1\.OpenQty \* ISNULL\(I\.NumInSale, 1\)/.test(poSql), 'qty_mt from OpenQty (not full Quantity)')
  assert.ok(/T1\.OpenQty \* T1\.Price/.test(poSql), 'line value from OpenQty * Price (not full LineTotal)')
  assert.ok(/T1\.LineStatus = 'O'/.test(poSql), "open-line filter LineStatus='O' present")
  assert.ok(/T1\.OpenQty > 0/.test(poSql), 'OpenQty > 0 filter present')
  assert.ok(/T0\.DocStatus = 'O' AND T0\.CANCELED = 'N'/.test(poSql), 'header open/not-cancelled filters kept')
  assert.ok(!poSql.includes('T1.Quantity'), 'full ordered Quantity no longer used')
  assert.ok(!poSql.includes('T1.LineTotal'), 'full LineTotal no longer used for PO value')
})

test('sales_plant_region_map_canonical', () => {
  const handler = buildSalesHandler(makeQueryStub())
  const plantRegion = handler.plantRegion
  assert.equal(typeof plantRegion, 'function', 'plantRegion exported for tests')
  // Canonical map — aligned with api/lib/margin_cube.js warehouse truth
  assert.equal(plantRegion('BAC'), 'Visayas', 'BAC = BACOLOD is Visayas (was wrongly Luzon)')
  assert.equal(plantRegion('ALAE'), 'Mindanao', 'ALAE is Mindanao (was wrongly Visayas)')
  assert.equal(plantRegion('SOUTH'), 'Mindanao', 'SOUTHMIN FEEDMILL is Mindanao (was Other)')
  assert.equal(plantRegion('CAG'), 'Mindanao')
  assert.equal(plantRegion('PFMIS'), 'Luzon', 'PFMC ISABELA is Luzon (was Other)')
  assert.equal(plantRegion('PFMCIS'), 'Luzon')
  assert.equal(plantRegion('HBEXT'), 'Visayas', 'HOREB EXTERNAL is Visayas (was Other)')
  assert.equal(plantRegion('HBEXT-QA'), 'Visayas')
  assert.equal(plantRegion('AC'), 'Luzon')
  assert.equal(plantRegion('ACEXT'), 'Luzon')
  assert.equal(plantRegion('HOREB'), 'Visayas')
  assert.equal(plantRegion('ARGAO'), 'Visayas')
  assert.equal(plantRegion('BUKID'), 'Mindanao')
  assert.equal(plantRegion('CCPC'), 'Mindanao')
  assert.equal(plantRegion('UNKNOWN-WH'), 'Other')
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

test('dashboard_pending_po_uses_openqty_open_lines', async () => {
  const queryStub = makeQueryStub()
  const handler = buildDashboardHandler(queryStub)
  const res = mockRes()
  await handler({ method: 'GET', headers: { 'x-session-id': 'u1' },
                  query: { period: 'MTD', region: 'ALL' } }, res)
  assert.equal(res.statusCode, 200)

  const poSql = queryStub.calls.map(c => c.sql).find(s => s.includes('FROM ORDR'))
  assert.ok(poSql, 'pending PO query ran')
  assert.ok(!poSql.includes('TOP 200'), 'no TOP truncation')
  assert.ok(/SUM\(T1\.OpenQty \* ISNULL\(I\.NumInSale, 1\)\)/.test(poSql), 'total_mt from OpenQty')
  assert.ok(/SUM\(T1\.OpenQty \* T1\.Price\)/.test(poSql), 'total_value from OpenQty * Price')
  assert.ok(/T1\.LineStatus = 'O'/.test(poSql), "open-line filter LineStatus='O' present")
  assert.ok(/T1\.OpenQty > 0/.test(poSql), 'OpenQty > 0 filter present')
  assert.ok(!poSql.includes('T1.LineTotal'), 'full LineTotal no longer used')
  assert.ok(!/SUM\(T1\.Quantity/.test(poSql), 'full Quantity no longer summed')
})
