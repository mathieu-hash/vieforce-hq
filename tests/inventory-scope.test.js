// Unit tests for api/inventory.js dual-auth pass-through — node:test.
// Run: node --test tests/inventory-scope.test.js   (or: npm test)
//
// Special case: inventory is plant-based (WhsCode) not customer-based.
// The handler resolves ?scope=user:<uuid> but NEVER uses it to filter SQL.
// Every caller — exec, DSM with is_empty, session user — gets the same
// national dataset. The response meta tells Patrol the scope was ignored.

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
    calls.push({ sql: sqlText.replace(/\s+/g, ' ').trim(), params })
    for (const [needle, rows] of responses) {
      if (sqlText.includes(needle)) return typeof rows === 'function' ? rows(params) : rows
    }
    return []
  }
  fn.calls = calls
  return fn
}

// Canned SAP responses — same dataset used in both tests to prove scope
// doesn't change what the DB returns.
function standardResponses() {
  const plants = [
    { plant_code: 'AC',    plant_name: 'AC Plant',    on_hand_bags: 500000, committed_bags: 100000, on_order_bags: 50000,
      available_bags: 400000, total_on_hand: 25000, total_committed: 5000, total_on_order: 2500, total_available: 20000 },
    { plant_code: 'HOREB', plant_name: 'HOREB Plant', on_hand_bags: 300000, committed_bags: 200000, on_order_bags: 30000,
      available_bags: 100000, total_on_hand: 15000, total_committed: 10000, total_on_order: 1500, total_available: 5000 },
    { plant_code: 'BUKID', plant_name: 'BUKID Plant', on_hand_bags: 400000, committed_bags: 50000, on_order_bags: 40000,
      available_bags: 350000, total_on_hand: 20000, total_committed: 2500, total_on_order: 2000, total_available: 17500 }
  ]
  // Needle order matters — first substring match wins. Each needle is a
  // SQL signature unique to that specific query in api/inventory.js.
  return [
    ['I.ItemName AS item_name',        []],                  // items detail (unique ItemName alias)
    ['GROUP BY W.WhsCode, W.WhsName',  plants],              // plants summary (only place with this GROUP BY)
    ["WHEN W.WhsCode IN ('AC','ACEXT','BAC')", [            // by_region (WhsCode CASE)
      { region: 'Luzon', on_hand_bags: 500000, committed_bags: 100000,
        on_order_bags: 50000, available_bags: 400000,
        on_hand: 25000, committed: 5000, on_order: 2500, available: 20000 }
    ]],
    ["WHEN UPPER(I.ItemName) LIKE '%HOG%'", [                // by_sales_group (ItemName CASE)
      { group_name: 'HOGS', on_hand_bags: 700000, committed_bags: 150000,
        on_order_bags: 80000, available_bags: 550000, on_hand_mt: 42000 }
    ]],
    ['AS negative_count',              [{ negative_count: 2 }]],
    ['FROM OWOR W',                    [{ plant_code: 'AC', bucket: 'real', wo_count: 3,
                                           bags: 60000, mt: 3000, oldest_due_date: null }]],
    ['AS avg_daily',                   [{ avg_daily: 500 }]]
  ]
}

function buildEnv(scopeResolvedBy, queryStub, serviceAuth = true) {
  const invPath = resetHandler()
  const apiDir = path.join(__dirname, '..', 'api')
  const libDir = path.join(__dirname, '..', 'lib')

  registerMock(invPath, path.join(apiDir, '_auth.js'), {
    verifySession: async () => (serviceAuth ? null : {
      id: 'session-user', name: 'Test', role: 'exec',
      region: 'ALL', district: null, territory: null
    }),
    verifyServiceToken: async () => (serviceAuth ? {
      id: 'svc:patrol', name: 'Patrol Service', role: 'service',
      region: 'ALL', district: 'ALL', territory: null, is_service: true
    } : null)
  })

  registerMock(invPath, path.join(apiDir, '_scope.js'), {
    scopeForUser: async (uuid) => scopeResolvedBy(uuid),
    buildScopeWhere: () => ({ sql: '', isEmpty: false })   // unused in inventory
  })

  registerMock(invPath, path.join(apiDir, '_db.js'), {
    query: queryStub,
    queryH: async () => [],
    queryBoth: async () => [],
    queryDateRange: async () => []
  })

  registerMock(invPath, path.join(libDir, 'cache.js'), {
    get: () => null,
    set: () => {}
  })

  return require(invPath)
}

// Helper: strip the optional scope field and compare the rest
function core(d) {
  const { scope, last_updated, ...rest } = d
  return rest
}

// ─────────────────────────────────────────────────────────────────────────
test('inventory_exec_returns_national_data_with_scope_applied_false', async () => {
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
  assert.ok(res.body.summary, 'summary present')
  assert.ok(Array.isArray(res.body.plants), 'plants[] present')
  assert.equal(res.body.plants.length, 3, '3 plants returned')
  assert.ok(res.body.by_region.length > 0, 'by_region populated')
  assert.ok(res.body.scope, 'scope meta present')
  assert.equal(res.body.scope.role, 'exec')
  assert.equal(res.body.scope.scope_applied, false, 'scope_applied MUST be false')
  assert.equal(res.body.scope.is_empty, false)
  assert.ok(res.body.scope.scope_applied_reason.includes('plant-based'),
            'reason explains plant-based rationale')

  // No SlpCode/CardCode scope filter anywhere in SQL — inventory ignores scope
  const sqls = queryStub.calls.map(c => c.sql)
  assert.ok(!sqls.some(s => /SlpCode IN \(/.test(s)),
            'no SlpCode IN scope filter injected into SQL')
  assert.ok(!sqls.some(s => /U_districtName IN \(/.test(s)),
            'no district filter injected either')
})

// ─────────────────────────────────────────────────────────────────────────
test('inventory_dsm_is_empty_still_returns_full_national_data', async () => {
  // Build two independent stubs using the SAME standard responses.
  // Call once as exec (ALL), once as DSM (is_empty). Assert both return
  // byte-identical core (ignoring scope + last_updated fields).
  const execStub = makeQueryStub(standardResponses())
  const execHandler = buildEnv(
    async () => ({ userId: 'mat', role: 'exec',
                    slpCodes: 'ALL', districtCodes: [], is_empty: false }),
    execStub
  )
  const execRes = mockRes()
  await execHandler({ method: 'GET', headers: { authorization: 'Bearer T' },
                       query: { scope: 'user:mat' } }, execRes)

  const dsmStub = makeQueryStub(standardResponses())
  const dsmHandler = buildEnv(
    async () => ({ userId: 'jefrey', role: 'dsm', name: 'Jefrey',
                    slpCodes: [], districtCodes: [], is_empty: true }),
    dsmStub
  )
  const dsmRes = mockRes()
  await dsmHandler({ method: 'GET', headers: { authorization: 'Bearer T' },
                      query: { scope: 'user:jefrey' } }, dsmRes)

  // CRITICAL: DSM with is_empty must NOT get a zero-state payload
  assert.equal(dsmRes.statusCode, 200)
  assert.ok(dsmRes.body.plants.length > 0,
            'DSM with is_empty still sees plants (no short-circuit)')
  assert.ok(dsmRes.body.summary.on_floor > 0,
            'DSM with is_empty still sees on_floor volume')

  // Data identity — everything except scope + last_updated must match
  assert.deepEqual(core(dsmRes.body), core(execRes.body),
                    'DSM and exec see byte-identical national inventory')

  // DSM's scope meta flags the ignored scope correctly
  assert.equal(dsmRes.body.scope.is_empty, true)
  assert.equal(dsmRes.body.scope.role, 'dsm')
  assert.equal(dsmRes.body.scope.scope_applied, false)
  assert.equal(execRes.body.scope.scope_applied, false)

  // Both callers hit the SAME SQL — scope doesn't change what's queried
  const execSqls = execStub.calls.map(c => c.sql.replace(/\s+/g, ' '))
  const dsmSqls  = dsmStub.calls.map(c => c.sql.replace(/\s+/g, ' '))
  assert.deepEqual(dsmSqls, execSqls,
                    'DSM and exec execute the same SQL queries in the same order')
})

// ─────────────────────────────────────────────────────────────────────────
test('inventory_no_scope_param_omits_scope_meta', async () => {
  const queryStub = makeQueryStub(standardResponses())
  const handler = buildEnv(
    async () => { throw new Error('scopeForUser should not be called without scope param') },
    queryStub,
    false   // session auth
  )

  const req = { method: 'GET', headers: { 'x-session-id': 'session-user' }, query: {} }
  const res = mockRes()
  await handler(req, res)

  assert.equal(res.statusCode, 200)
  assert.equal(res.body.scope, undefined, 'scope key omitted on no-scope path')
  assert.ok(res.body.plants.length > 0, 'data still populated for dashboard')
})
