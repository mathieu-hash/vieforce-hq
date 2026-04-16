const sql = require('mssql')

const config = {
  server:   process.env.SAP_HOST,
  port:     parseInt(process.env.SAP_PORT) || 4444,
  database: process.env.SAP_DB,
  user:     process.env.SAP_USER,
  password: process.env.SAP_PASS,
  options: {
    encrypt: false,
    trustServerCertificate: true,
    connectionTimeout: 15000,
    requestTimeout: 30000
  },
  pool: { max: 10, min: 0, idleTimeoutMillis: 30000 }
}

let pool = null

async function getPool() {
  if (!pool) {
    pool = await sql.connect(config)
  }
  return pool
}

async function query(sqlText, params = {}) {
  const p = await getPool()
  const request = p.request()
  Object.entries(params).forEach(([k, v]) => {
    if (v instanceof Date) {
      request.input(k, sql.DateTime, v)
    } else if (typeof v === 'number') {
      request.input(k, Number.isInteger(v) ? sql.Int : sql.Float, v)
    } else {
      request.input(k, sql.NVarChar, v)
    }
  })
  const result = await request.query(sqlText)
  return result.recordset
}

module.exports = { query, sql, getPool }
