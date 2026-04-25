// Unit tests for api/_scope.js — exercised via node:test (no external deps).
// Run: node --test tests/scope.test.js
//
// Uses a hand-rolled Supabase mock. Validates scope resolution for the four
// role paths (exec, rsm, dsm, tsr) plus buildScopeWhere / emptySalesPayload
// edge cases. No network calls, no HQ API required.

const test = require('node:test')
const assert = require('node:assert/strict')

const { scopeForUser, buildScopeWhere, emptySalesPayload, scopeResponseMeta } =
  require('../api/_scope.js')

// ── Supabase mock ─────────────────────────────────────────────────────────
// Minimal query-builder that records .from(table) + .eq(col, val) + .single()
// and returns canned rows from a fixture.
function makeMock(fixture) {
  return {
    from(table) {
      const filters = []
      const builder = {
        _table: table,
        _filters: filters,
        select() { return builder },
        eq(col, val) { filters.push([col, val]); return builder },
        not(col, _op, val) { filters.push(['not_null:' + col]); return builder },
        single() {
          const rows = (fixture[table] || []).filter(row =>
            filters.every(([col, val]) =>
              col.startsWith('not_null:')
                ? row[col.slice(9)] != null
                : row[col] === val
            )
          )
          return Promise.resolve({ data: rows[0] || null, error: rows[0] ? null : { message: 'not found' } })
        },
        then(resolve) {
          const rows = (fixture[table] || []).filter(row =>
            filters.every(([col, val]) =>
              col.startsWith('not_null:')
                ? row[col.slice(9)] != null
                : row[col] === val
            )
          )
          resolve({ data: rows, error: null })
        }
      }
      return builder
    }
  }
}

const MAT   = 'b3bb7fc6-8e8d-4529-9166-db11b2c78b61'
const RINA  = 'a6fd4925-5d15-4e33-b9ff-8631aa89c14f'
const JEFREY = '5d710fc6-8351-439f-b0e1-c91a76719ccb'
const RICO  = '4bc1c7c0-213b-49cc-9b88-1730b2906bbd'
const JAKE  = 'e2caaab1-2eca-44d7-9ec5-e5d2f520819d'

const FIXTURE = {
  users: [
    { id: MAT,    role: 'exec', name: 'Mathieu',           manager_id: null,    sap_slpcode: null, sap_district_code: null, district_label: null,       is_active: true },
    { id: RINA,   role: 'rsm',  name: 'Rina Morales',      manager_id: MAT,     sap_slpcode: null, sap_district_code: null, district_label: 'Luzon',    is_active: true },
    { id: JEFREY, role: 'dsm',  name: 'Jefrey Florentino', manager_id: RINA,    sap_slpcode: 17,   sap_district_code: 10,   district_label: 'MM-North', is_active: true },
    { id: RICO,   role: 'tsr',  name: 'Rico Abante',       manager_id: JEFREY,  sap_slpcode: 5,    sap_district_code: null, district_label: null,       is_active: true },
    { id: JAKE,   role: 'tsr',  name: 'Jake Santos',       manager_id: JEFREY,  sap_slpcode: null, sap_district_code: null, district_label: null,       is_active: true }
  ]
}

test('exec_scope_returns_ALL', async () => {
  const supa = makeMock(FIXTURE)
  const s = await scopeForUser(MAT, supa)
  assert.equal(s.role, 'exec')
  assert.equal(s.slpCodes, 'ALL')
  assert.deepEqual(s.districtCodes, [])
  assert.equal(s.is_empty, false)
})

// 2026-04-25: director + evp added to elevated allowlist.
// Pre-fix, both fell through to the unknown-role catch-all and got
// is_empty=true (Joel Durano + Joel Comex saw zero-state on Patrol
// despite being above RSMs in the org chart).
const JOEL_DURANO = 'aaaaaaaa-1111-1111-1111-111111111111'
const JOEL_COMEX  = 'bbbbbbbb-2222-2222-2222-222222222222'
const ELEVATED_FIXTURE = {
  users: [
    { id: JOEL_DURANO, role: 'director', name: 'Joel Durano', manager_id: null, sap_slpcode: 3, sap_district_code: null, district_label: null, is_active: true },
    { id: JOEL_COMEX,  role: 'evp',      name: 'Joel Comex',  manager_id: null, sap_slpcode: null, sap_district_code: null, district_label: null, is_active: true }
  ]
}

test('director_scope_returns_ALL', async () => {
  const supa = makeMock(ELEVATED_FIXTURE)
  const s = await scopeForUser(JOEL_DURANO, supa)
  assert.equal(s.role, 'director')
  assert.equal(s.slpCodes, 'ALL', 'director sees national book')
  assert.equal(s.is_empty, false, 'director NOT in zero-state')
})

test('evp_scope_returns_ALL', async () => {
  const supa = makeMock(ELEVATED_FIXTURE)
  const s = await scopeForUser(JOEL_COMEX, supa)
  assert.equal(s.role, 'evp')
  assert.equal(s.slpCodes, 'ALL', 'evp sees national book')
  assert.equal(s.is_empty, false, 'evp NOT in zero-state')
})

test('dsm_scope_returns_tsrs_plus_own_plus_district', async () => {
  const supa = makeMock(FIXTURE)
  const s = await scopeForUser(JEFREY, supa)
  assert.equal(s.role, 'dsm')
  // Rico (5) + Jefrey's own (17); Jake has null sap_slpcode → excluded
  assert.deepEqual([...s.slpCodes].sort((a, b) => a - b), [5, 17])
  assert.deepEqual(s.districtCodes, [10])
  assert.equal(s.is_empty, false)
  assert.equal(s.district_label, 'MM-North')
})

test('tsr_scope_returns_only_own_slpcode', async () => {
  const supa = makeMock(FIXTURE)
  const s = await scopeForUser(RICO, supa)
  assert.equal(s.role, 'tsr')
  assert.deepEqual(s.slpCodes, [5])
  assert.deepEqual(s.districtCodes, [])
  assert.equal(s.is_empty, false)
})

test('tsr_without_slpcode_resolves_to_empty', async () => {
  const supa = makeMock(FIXTURE)
  const s = await scopeForUser(JAKE, supa)
  assert.equal(s.role, 'tsr')
  assert.deepEqual(s.slpCodes, [])
  assert.equal(s.is_empty, true)
})

test('rsm_scope_walks_dsm_chain', async () => {
  const supa = makeMock(FIXTURE)
  const s = await scopeForUser(RINA, supa)
  assert.equal(s.role, 'rsm')
  // Jefrey (17) from DSM own + Rico (5) from DSM's TSRs; Jake excluded (null)
  assert.deepEqual([...s.slpCodes].sort((a, b) => a - b), [5, 17])
  assert.deepEqual(s.districtCodes, [10])
  assert.equal(s.is_empty, false)
})

test('unknown_user_returns_empty_with_error', async () => {
  const supa = makeMock(FIXTURE)
  const s = await scopeForUser('00000000-0000-0000-0000-000000000000', supa)
  assert.equal(s.error, 'user_not_found')
  assert.equal(s.is_empty, true)
})

test('buildScopeWhere_ALL_returns_empty_sql', () => {
  const { sql, isEmpty } = buildScopeWhere({ slpCodes: 'ALL', districtCodes: [], is_empty: false })
  assert.equal(sql, '')
  assert.equal(isEmpty, false)
})

test('buildScopeWhere_empty_signals_caller', () => {
  const { sql, isEmpty } = buildScopeWhere({ slpCodes: [], districtCodes: [], is_empty: true })
  assert.equal(sql, '')
  assert.equal(isEmpty, true)
})

test('buildScopeWhere_filters_out_slpcode_1_and_ce_prefix', () => {
  const { sql, isEmpty } = buildScopeWhere({ slpCodes: [1, 5, 17], districtCodes: [10], is_empty: false })
  assert.equal(isEmpty, false)
  assert.match(sql, /CardCode NOT LIKE 'CE%'/)
  assert.match(sql, /SC\.SlpCode IN \(5,17\)/)  // 1 stripped
  assert.match(sql, /SC\.SlpCode <> 1/)
  assert.match(sql, /U_districtName IN \(10\)/)
})

test('buildScopeWhere_no_scope_returns_empty_sql_not_empty_flag', () => {
  const { sql, isEmpty } = buildScopeWhere(null)
  assert.equal(sql, '')
  assert.equal(isEmpty, false)   // no scope = no restriction, not a zero-state
})

test('emptySalesPayload_matches_sales_response_shape', () => {
  const meta = scopeResponseMeta({ userId: RICO, role: 'tsr', name: 'Rico', district_label: null, slpCodes: [], districtCodes: [], is_empty: true })
  const p = emptySalesPayload(meta)
  assert.equal(p.scope.userId, RICO)
  assert.equal(p.scope.is_empty, true)
  assert.equal(p.kpis.volume_mt, 0)
  assert.deepEqual(p.by_brand, [])
  assert.deepEqual(p.top_customers, [])
  assert.equal(p.pending_po.summary.total_mt, 0)
})

test('scopeResponseMeta_ALL_reports_null_count', () => {
  const meta = scopeResponseMeta({ userId: MAT, role: 'exec', name: 'Mat', district_label: null, slpCodes: 'ALL', districtCodes: [], is_empty: false })
  assert.equal(meta.slpCodes_count, null)
  assert.equal(meta.is_empty, false)
})
