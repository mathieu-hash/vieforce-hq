// Regression test for the Speed run-rate basis: today (still in progress) must
// NOT be counted as an elapsed/delivered shipping day. The rate is computed over
// COMPLETED shipping days only (through the last completed day = yesterday).

const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const Module = require('module')
const { countShippingDays, getManilaToday, getPeriodBounds } = require('../api/lib/shipping_days')

function registerMock(requestingFile, relPath, exportsObj) {
  const resolved = Module._resolveFilename(relPath, {
    id: requestingFile, filename: requestingFile,
    paths: Module._nodeModulePaths(path.dirname(requestingFile))
  })
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, children: [], paths: [], exports: exportsObj }
  return resolved
}

function mockRes() {
  return {
    statusCode: 200, headers: {}, body: null,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v },
    status(c) { this.statusCode = c; return this },
    json(o) { this.body = o; return this },
    end() { return this }
  }
}

function buildEnv(captured) {
  const speedPath = path.join(__dirname, '..', 'api', 'speed.js')
  delete require.cache[speedPath]
  const apiDir = path.join(__dirname, '..', 'api')
  const libDir = path.join(__dirname, '..', 'lib')

  const queryStub = async (sql, params) => { captured.push({ sql: sql.replace(/\s+/g, ' ').trim(), params }); return [] }

  registerMock(speedPath, path.join(apiDir, '_auth.js'), {
    verifySession: async () => ({ id: 'u', name: 'Exec', role: 'exec', region: 'ALL', district: null, territory: null }),
    verifyServiceToken: async () => null,
    applyRoleFilter: (_s, w) => w
  })
  registerMock(speedPath, path.join(apiDir, '_scope.js'), {
    resolveRequestScope: async () => null,
    scopeForUser: async () => null,
    buildScopeWhere: () => ({ sql: '', isEmpty: false })
  })
  registerMock(speedPath, path.join(apiDir, '_db.js'), {
    query: queryStub, queryH: async () => [], queryBoth: async () => [], queryDateRange: async () => []
  })
  registerMock(speedPath, path.join(libDir, 'cache.js'), { get: () => null, set: () => {}, keyableUrl: (u) => u })
  return require(speedPath)
}

test('Speed rate window ends at the last COMPLETED day (today excluded)', async () => {
  const captured = []
  const handler = buildEnv(captured)
  await handler({ method: 'GET', headers: { 'x-session-id': 'u' }, query: { period: 'MTD' } }, mockRes())

  // The factual volume query (actual_mt) runs THROUGH today...
  const totalQ = captured.find(c => c.sql.includes('AS actual_mt'))
  assert.ok(totalQ, 'total (through-today) query ran')
  const today = totalQ.params.dateTo

  // ...but the RATE query (completed_mt) must end at asOf = today - 1 day.
  const rateQ = captured.find(c => c.sql.includes('AS completed_mt'))
  assert.ok(rateQ, 'completed-day rate query ran')
  const asOf = rateQ.params.asOf
  assert.ok(asOf instanceof Date, 'asOf is a Date param')

  const dayMs = 86400000
  const diffDays = Math.round((new Date(today).setHours(0,0,0,0) - new Date(asOf).setHours(0,0,0,0)) / dayMs)
  assert.equal(diffDays, 1, 'rate window ends exactly one calendar day before today')
})

test('shipping_days_elapsed excludes today', async () => {
  const captured = []
  const handler = buildEnv(captured)
  const res = mockRes()
  await handler({ method: 'GET', headers: { 'x-session-id': 'u' }, query: { period: 'MTD' } }, res)

  const today = getManilaToday()
  const asOf = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1)
  const { start } = getPeriodBounds('MTD', today)

  const expectedElapsed = countShippingDays(start, asOf)          // completed days only
  const withToday       = countShippingDays(start, today)         // the old (buggy) count

  assert.equal(res.body.shipping_days_elapsed, expectedElapsed,
    'elapsed = completed shipping days through yesterday')
  // On any day where today itself is a shipping day, excluding it must reduce the count.
  const todayIsShippingDay = withToday - expectedElapsed === 1
  const todayIsClosed      = withToday - expectedElapsed === 0
  assert.ok(todayIsShippingDay || todayIsClosed,
    'elapsed is at most the through-today count (never inflates)')
})
