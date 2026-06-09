// Unit tests for api/inventory.js UoM conversions — node:test.
// Run: node --test tests/inventory-uom.test.js   (or: npm test)
//
// Bug fixes covered:
//  (1) 50x inflation — OITW.OnHand is in KILO. MT = OnHand/1000 (NOT
//      OnHand*NumInSale/1000, which multiplied kg by the 50KG/BAG factor → 50x).
//      Bags = OnHand/NumInSale. MT aggregates are guarded to InvntryUom='KILO'
//      so piece/vial SKUs don't pollute tonnage.
//  (2) Available KPI showed 0 — the grand-total available was clamped with
//      Math.max(0, ...). It must be a real signed number (negative = shortage).

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
  const p = path.join(__dirname, '..', 'api', 'inventory.js')
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
    calls.push({ raw: sqlText, sql: sqlText.replace(/\s+/g, ' ').trim(), params })
    for (const [needle, rows] of responses) {
      if (sqlText.includes(needle)) return typeof rows === 'function' ? rows(params) : rows
    }
    return []
  }
  fn.calls = calls
  return fn
}

// One plant whose committed exceeds on-hand so the signed grand-total available
// is negative — proves the Available KPI is no longer clamped to 0.
function responses() {
  const plants = [
    { plant_code: 'AC', plant_name: 'AC Plant',
      on_hand_bags: 14477, committed_bags: 14600, on_order_bags: 1000,
      available_bags: -123,
      total_on_hand: 723.9, total_committed: 730.0, total_on_order: 50.0,
      total_available: -6.1 }
  ]
  return [
    ['I.ItemName AS item_name',        []],
    ['GROUP BY W.WhsCode, W.WhsName',  plants],
    ["WHEN W.WhsCode IN ('AC','ACEXT','BAC')", []],
    ["WHEN UPPER(I.ItemName) LIKE '%HOG%'", []],
    ['AS negative_count',              [{ negative_count: 7 }]],
    ['FROM OWOR W',                    []],
    ['AS avg_daily',                   [{ avg_daily: 180 }]]
  ]
}

function buildEnv(queryStub) {
  const invPath = resetHandler()
  const apiDir = path.join(__dirname, '..', 'api')
  const libDir = path.join(__dirname, '..', 'lib')

  registerMock(invPath, path.join(apiDir, '_auth.js'), {
    verifySession: async () => ({ id: 'u', name: 'T', role: 'exec',
      region: 'ALL', district: null, territory: null }),
    verifyServiceToken: async () => null
  })
  registerMock(invPath, path.join(apiDir, '_scope.js'), {
    scopeForUser: async () => ({}), buildScopeWhere: () => ({ sql: '', isEmpty: false })
  })
  registerMock(invPath, path.join(apiDir, '_db.js'), {
    query: queryStub, queryH: async () => [], queryBoth: async () => [], queryDateRange: async () => []
  })
  registerMock(invPath, path.join(libDir, 'cache.js'), { get: () => null, set: () => {} })
  return require(invPath)
}

// ─────────────────────────────────────────────────────────────────────────
test('MT conversions use /1000 and never multiply by NumInSale', async () => {
  const stub = makeQueryStub(responses())
  const handler = buildEnv(stub)
  await handler({ method: 'GET', headers: { 'x-session-id': 'u' }, query: {} }, mockRes())

  const sqls = stub.calls.map(c => c.raw)
  assert.ok(sqls.length > 0, 'queries ran')

  // No MT/quantity column may multiply OnHand/Quantity/PlannedQty by NumInSale.
  // (Bags divide by NumInSale; that's the only legitimate NumInSale use.)
  for (const s of sqls) {
    assert.ok(!/\*\s*ISNULL\(I\.NumInSale/.test(s),
      'no "* ISNULL(I.NumInSale...)" — that was the 50x inflation bug')
  }

  // The on-hand MT aggregate must divide by 1000 and be KILO-guarded.
  const plantSql = sqls.find(s => s.includes('GROUP BY W.WhsCode, W.WhsName'))
  assert.ok(plantSql, 'plant summary query present')
  assert.match(plantSql, /total_on_hand/, 'has total_on_hand')
  assert.match(plantSql, /\/ 1000\.0/, 'divides kg by 1000 for MT')
  assert.match(plantSql, /InvntryUom\s*=\s*'KILO'/,
    'MT aggregate guarded to InvntryUom=KILO')

  // Bags divide by NumInSale (kg → 50KG bags), not raw OnHand.
  assert.match(plantSql, /OnHand \/ NULLIF\(ISNULL\(I\.NumInSale/,
    'bags = OnHand / NumInSale (zero-safe)')
})

test('InvntryUom KILO guard present in every MT-bearing query', async () => {
  const stub = makeQueryStub(responses())
  const handler = buildEnv(stub)
  await handler({ method: 'GET', headers: { 'x-session-id': 'u' }, query: {} }, mockRes())

  const sqls = stub.calls.map(c => c.raw)
  const mtQueries = sqls.filter(s =>
    /total_on_hand|on_hand_mt|qty_on_hand|AS mt\b|AS avg_daily/.test(s))
  assert.ok(mtQueries.length >= 4, 'found the MT-bearing queries')
  for (const s of mtQueries) {
    assert.match(s, /InvntryUom\s*=\s*'KILO'/,
      'each MT/tonnage query restricts to weight-UoM items')
  }
})

test('Available grand-total is a real signed number, not clamped to 0', async () => {
  const stub = makeQueryStub(responses())
  const handler = buildEnv(stub)
  const res = mockRes()
  await handler({ method: 'GET', headers: { 'x-session-id': 'u' }, query: {} }, res)

  const s = res.body.summary
  // total_available = -6.1 MT, available_bags = -123 → both must surface negative.
  assert.equal(s.available_mt, -6.1, 'available_mt reflects signed total (not 0)')
  assert.equal(s.available, -123, 'available (bags) reflects signed total (not 0)')
})
