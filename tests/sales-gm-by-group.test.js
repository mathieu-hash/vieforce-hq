// Unit tests for api/sales.js gm_by_group SSG×12-month GM ₱/ton matrix — node:test.
// Run: node --test tests/sales-gm-by-group.test.js   (or: npm test)
//
// Covers the live replacement for the old hardcoded "GM per Ton by Group" table:
//   1. The matrix query is finished-feed scoped (ItmsGrpCod=103), joins [@OITMSSG]
//      on OITM.U_SSG, computes ₱/ton = SUM(GrssProfit)/(SUM(InvQty)/1000), and
//      applies the SAME region+segment line filters as the rest of the page.
//   2. region=ALL emits no region predicate; region=Visayas does (via real business_filters).
//   3. The shaped gm_by_group payload (months / groups / avg) is correct, tons-sorted,
//      UNSPEC→Untagged, gm_ton rounded to integer.
//
// Mocks _db / _auth / _scope / ../lib/cache. Uses the REAL business_filters so the
// region/segment SQL fragments are genuinely produced (not stubbed away).

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

// queryBoth feeds the matrix; everything else returns []. gmRows is keyed off the
// unique '@OITMSSG' join signature.
function buildHandler(gmRows) {
  const salesPath = path.join(apiDir, 'sales.js')
  delete require.cache[salesPath]

  const calls = []
  const query        = async () => []
  const queryDateRange = async () => []
  const queryBoth    = async (sqlText, params) => {
    calls.push({ sql: sqlText, params })
    if (sqlText.includes('[@OITMSSG]')) return gmRows
    return []
  }

  registerMock(salesPath, path.join(apiDir, '_auth.js'), {
    verifyServiceToken: async () => null,
    verifySession: async () => ({ id: 'u1', name: 'Exec', role: 'exec', region: 'ALL' }),
    getPeriodDates: () => ({ dateFrom: new Date(2026, 4, 1), dateTo: new Date(2026, 4, 31) }),
    applyRoleFilter: (_s, w) => w   // exec → no role narrowing
  })
  registerMock(salesPath, path.join(apiDir, '_scope.js'), {
    scopeForUser: async () => null,
    buildScopeWhere: () => ({ sql: '', isEmpty: false }),
    emptySalesPayload: () => ({}),
    scopeResponseMeta: () => ({})
  })
  registerMock(salesPath, path.join(apiDir, '_db.js'), { query, queryBoth, queryDateRange })
  registerMock(salesPath, path.join(libDir, 'cache.js'), { get: () => null, set: () => {} })
  // business_filters is intentionally NOT mocked — we want the real region/segment SQL.

  const handler = require(salesPath)
  handler._gmCalls = calls
  return handler
}

function run(handler, query) {
  const res = mockRes()
  return handler({ method: 'GET', headers: { 'x-session-id': 'u1' }, query }, res).then(() => res)
}

function gmSql(handler) {
  return handler._gmCalls.map(c => c.sql).find(s => s.includes('[@OITMSSG]'))
}

test('gm_by_group SQL is finished-feed scoped and computes ₱/ton from InvQty', async () => {
  const handler = buildHandler([])
  await run(handler, { period: 'MTD', region: 'ALL', segment: 'ALL' })
  const sql = gmSql(handler)
  assert.ok(sql, 'gm_by_group matrix query ran')
  assert.ok(/I\.ItmsGrpCod = 103/.test(sql), 'finished-feed scope (ItmsGrpCod=103)')
  assert.ok(sql.includes('LEFT JOIN [@OITMSSG] S ON S.Code = I.U_SSG'), 'SSG name join on OITM.U_SSG')
  assert.ok(sql.includes('SUM(T1.GrssProfit)'), 'gross profit summed for ₱/ton numerator')
  assert.ok(sql.includes('SUM(T1.InvQty) / 1000.0'), 'tons = InvQty/1000 (kg basis)')
  assert.ok(sql.includes("T0.CANCELED = 'N'"), 'cancelled invoices excluded')
  assert.ok(sql.includes('T1.InvQty > 0'), 'zero/negative qty lines excluded')
  assert.ok(/GROUP BY .*FORMAT\(T0\.DocDate, 'yyyy-MM'\)/.test(sql.replace(/\s+/g, ' ')), 'grouped by SSG name + month')
  assert.ok(sql.includes('@gmStart'), 'parameterized window start (no interpolation)')
})

test('gm_by_group applies region + segment filters (Visayas + KA) like the rest of sales', async () => {
  const handler = buildHandler([])
  await run(handler, { period: 'MTD', region: 'Visayas', segment: 'KA' })
  const sql = gmSql(handler)
  // region: regionCaseSql on the INV1 line alias (T1) = @region
  assert.ok(/T1\.WhsCode IN \('HOREB','ARGAO','ALAE'\)/.test(sql), 'region case on line alias present')
  assert.ok(sql.includes('= @region'), 'region predicate present')
  // segment: KA predicate on the doc alias T0
  assert.ok(/T0\.SlpCode IN \(/.test(sql), 'KA segment predicate present (SlpCode list)')
  const params = handler._gmCalls.find(c => c.sql.includes('[@OITMSSG]')).params
  assert.equal(params.region, 'Visayas', 'region param passed through')
})

test('gm_by_group region=ALL emits no region predicate', async () => {
  const handler = buildHandler([])
  await run(handler, { period: 'MTD', region: 'ALL', segment: 'ALL' })
  const sql = gmSql(handler)
  assert.ok(!sql.includes('= @region'), 'no region predicate for ALL')
  assert.ok(!/T1\.WhsCode IN \('HOREB'/.test(sql), 'no region case fragment for ALL')
  assert.ok(!/T0\.SlpCode IN \(/.test(sql), 'no segment predicate for ALL')
})

test('gm_by_group payload shape: months/groups/avg, tons-sorted, UNSPEC→Untagged, integer ₱/ton', async () => {
  // Pick the two most recent months from a live run so rows land inside the window.
  const probe = buildHandler([])
  await run(probe, { period: 'MTD', region: 'ALL', segment: 'ALL' })
  // Re-derive months exactly as the handler does is brittle; instead read them back
  // from a payload built with empty rows.
  const empty = probe
  const res0 = await run(empty, { period: 'MTD', region: 'ALL', segment: 'ALL' })
  const months = res0.body.gm_by_group.months
  assert.equal(months.length, 12, '12 trailing calendar months')
  const m1 = months[10], m2 = months[11]   // two most recent (m2 = current)

  const gmRows = [
    // PIG: bigger tons overall → should sort first
    { ssg: 'PIG',    ym: m1, gp: 700000, tons: 100 },   // ₱7,000/ton
    { ssg: 'PIG',    ym: m2, gp: 360000, tons:  50 },   // ₱7,200/ton
    // PIGLET: smaller tons
    { ssg: 'PIGLET', ym: m1, gp: 200000, tons:  20 },   // ₱10,000/ton
    // Untagged from UNSPEC
    { ssg: 'UNSPEC', ym: m2, gp:  50000, tons:  10 },   // ₱5,000/ton
  ]
  const handler = buildHandler(gmRows)
  const res = await run(handler, { period: 'MTD', region: 'ALL', segment: 'ALL' })
  assert.equal(res.statusCode, 200)
  const g = res.body.gm_by_group
  assert.ok(g, 'gm_by_group present in payload')
  assert.equal(g.current_month, m2, 'current_month flagged')

  // groups sorted by total tons desc → PIG (150) before PIGLET (20) before Untagged (10)
  assert.deepEqual(g.groups.map(x => x.ssg), ['PIG', 'PIGLET', 'Untagged'], 'tons-desc sort + UNSPEC→Untagged')

  const pig = g.groups[0]
  const cellM1 = pig.cells.find(c => c.ym === m1)
  const cellM2 = pig.cells.find(c => c.ym === m2)
  assert.equal(cellM1.gm_ton, 7000, 'PIG m1 ₱/ton = 700000/100')
  assert.equal(cellM2.gm_ton, 7200, 'PIG m2 ₱/ton = 360000/50')
  assert.equal(Number.isInteger(cellM1.gm_ton), true, 'gm_ton is an integer')
  // a month with no PIG rows is a null cell
  const emptyCell = pig.cells.find(c => c.ym === months[0])
  assert.equal(emptyCell.gm_ton, null, 'absent month → null cell')

  // avg row is volume-weighted across all groups for the month:
  // m1: (700000+200000)/(100+20)=900000/120=7500
  const avgM1 = g.avg.find(c => c.ym === m1)
  assert.equal(avgM1.gm_ton, 7500, 'avg row volume-weighted = SUM(gp)/SUM(tons)')
})
