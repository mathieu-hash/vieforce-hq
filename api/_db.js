const sql = require('mssql')

// Shared server config (same host/creds/port for both DBs)
const BASE = {
  server:   process.env.SAP_HOST || process.env.SCOS_SAP_HOST,
  port:     parseInt(process.env.SAP_PORT || process.env.SCOS_SAP_PORT) || 4444,
  user:     process.env.SAP_USER || process.env.SCOS_SAP_USER,
  password: process.env.SAP_PASS || process.env.SCOS_SAP_PASS,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    connectionTimeout: 15000,
    requestTimeout: 45000
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
}

const configCurrent = {
  ...BASE,
  database: process.env.SAP_DB || process.env.SCOS_SAP_DB || 'Vienovo_Live'
}

const configHistorical = {
  ...BASE,
  database: process.env.SAP_DB_HISTORICAL || 'Vienovo_Old'
}

// Migration cutoff — queries for dates < cutoff go to historical, >= cutoff go to current
const MIGRATION_CUTOFF = new Date(process.env.SAP_MIGRATION_CUTOFF || '2026-01-01T00:00:00Z')

let poolCurrent = null
let poolHistorical = null

async function getPool() {
  if (!poolCurrent) poolCurrent = await sql.connect(configCurrent)
  return poolCurrent
}

async function getHistoricalPool() {
  if (!poolHistorical) {
    poolHistorical = new sql.ConnectionPool(configHistorical)
    await poolHistorical.connect()
  }
  return poolHistorical
}

function bindParams(request, params) {
  Object.entries(params).forEach(([k, v]) => {
    if (v instanceof Date) {
      request.input(k, sql.DateTime, v)
    } else if (typeof v === 'number') {
      request.input(k, Number.isInteger(v) ? sql.Int : sql.Float, v)
    } else {
      request.input(k, sql.NVarChar, v)
    }
  })
}

// Current-database query (Vienovo_Live) — default for all new SAP data post-2026-01-01
async function query(sqlText, params = {}) {
  const p = await getPool()
  const request = p.request()
  bindParams(request, params)
  const result = await request.query(sqlText)
  return result.recordset
}

// Historical-database query (Vienovo_Old) — for pre-2026-01-01 data
async function queryH(sqlText, params = {}) {
  const p = await getHistoricalPool()
  const request = p.request()
  bindParams(request, params)
  const result = await request.query(sqlText)
  return result.recordset
}

// Run the SAME query on both pools and concatenate. Useful for span-across windows
// (e.g. "last 12 months" = Apr 2025 - Apr 2026) where the SQL has no DB-specific
// prefix and we only need the UNION of rows. The caller is responsible for any
// deduping or aggregation on the combined set.
async function queryBoth(sqlText, params = {}) {
  const [cur, hist] = await Promise.all([
    query(sqlText, params).catch(e => { console.warn('[queryBoth] current failed:', e.message); return [] }),
    queryH(sqlText, params).catch(e => { console.warn('[queryBoth] historical failed:', e.message); return [] })
  ])
  return [...hist, ...cur]
}

// Date-aware dispatch. Runs `sqlText` against the correct pool(s) given a date range.
// Contract: `sqlText` must reference the range as @dateFrom / @dateTo params.
// When the range spans the cutoff, the query is split into two windows:
//   historical: [dateFrom, cutoff - 1ms]
//   current:    [cutoff,   dateTo]
// The two recordsets are concatenated in [historical, current] order.
async function queryDateRange(sqlText, params, dateFrom, dateTo) {
  const cutoff = MIGRATION_CUTOFF
  if (dateTo < cutoff) {
    // Entirely pre-migration
    return queryH(sqlText, { ...params, dateFrom, dateTo })
  }
  if (dateFrom >= cutoff) {
    // Entirely post-migration
    return query(sqlText, { ...params, dateFrom, dateTo })
  }
  // Spans cutoff → split
  const histTo = new Date(cutoff.getTime() - 1)  // 1ms before cutoff
  const currFrom = cutoff
  const [hist, curr] = await Promise.all([
    queryH(sqlText, { ...params, dateFrom, dateTo: histTo })
      .catch(e => { console.warn('[queryDateRange] historical failed:', e.message); return [] }),
    query(sqlText, { ...params, dateFrom: currFrom, dateTo })
      .catch(e => { console.warn('[queryDateRange] current failed:', e.message); return [] })
  ])
  return [...hist, ...curr]
}

module.exports = {
  query,
  queryH,
  queryBoth,
  queryDateRange,
  sql,
  getPool,
  getHistoricalPool,
  MIGRATION_CUTOFF
}
