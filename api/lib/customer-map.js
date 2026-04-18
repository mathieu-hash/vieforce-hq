// Customer-code translation layer between Vienovo_Live and Vienovo_Old.
//
// The Jan 2026 SAP migration RE-KEYED every customer. Old codes follow `CL00XXX`,
// new codes follow `CA000XXX`. There is NO direct code overlap between the two DBs
// (verified via /api/diag?cust_map=1 on 2026-04-18: 0/1382 code matches).
//
// This module builds a bi-directional name-based mapping cached for 1 hour and
// exposes lookups any LY-capable endpoint can use to translate between code
// spaces before joining.
//
// Mapping rule: case-insensitive trimmed CardName equality.
// Coverage on 2026-04-18: 899/1382 current customers (65%) name-match historical;
// 700/788 active 2026 customers (89%) name-match historical.

const { query, queryH } = require('../_db')

const TTL_MS = 60 * 60 * 1000   // 1h — customer master rarely changes intra-day

let _mapData = null
let _mapBuiltAt = 0
let _mapPromise = null

function normName(s) {
  return (s || '').trim().toUpperCase().replace(/\s+/g, ' ')
}

async function buildMap() {
  const [cur, hist] = await Promise.all([
    query(`SELECT CardCode, CardName FROM OCRD WHERE CardType='C'`).catch(() => []),
    queryH(`SELECT CardCode, CardName FROM OCRD WHERE CardType='C'`).catch(() => [])
  ])

  const histByName = new Map()
  for (const r of hist) {
    const k = normName(r.CardName)
    if (!k) continue
    // If duplicates by name, prefer the earliest CardCode (longest history)
    if (!histByName.has(k)) histByName.set(k, r.CardCode)
  }

  const currentToHistorical = new Map()
  const historicalToCurrent = new Map()
  for (const r of cur) {
    const k = normName(r.CardName)
    if (!k) continue
    const hCode = histByName.get(k)
    if (hCode) {
      currentToHistorical.set(r.CardCode, hCode)
      // If two current codes mapped to same historical (rare), the later one wins.
      // That is acceptable because per-current-code lookups are the primary path.
      historicalToCurrent.set(hCode, r.CardCode)
    }
  }

  return {
    currentToHistorical,
    historicalToCurrent,
    builtAt: Date.now(),
    counts: {
      current: cur.length,
      historical: hist.length,
      mapped: currentToHistorical.size,
      unmapped: cur.length - currentToHistorical.size
    }
  }
}

async function getCustomerMap() {
  if (_mapData && (Date.now() - _mapBuiltAt) < TTL_MS) return _mapData
  if (_mapPromise) return _mapPromise
  _mapPromise = buildMap().then(m => {
    _mapData = m
    _mapBuiltAt = m.builtAt
    _mapPromise = null
    return m
  }).catch(e => { _mapPromise = null; throw e })
  return _mapPromise
}

// Convenience: return the historical CardCode for a given current CardCode,
// or `null` if the customer has no historical equivalent (i.e. created after migration).
async function toHistoricalCode(currentCode) {
  const m = await getCustomerMap()
  return m.currentToHistorical.get(currentCode) || null
}

// Inverse: return the current CardCode for a given historical CardCode.
async function toCurrentCode(historicalCode) {
  const m = await getCustomerMap()
  return m.historicalToCurrent.get(historicalCode) || null
}

// Translate an array of historical-coded rows into current-coded rows.
// Drops rows whose historical CardCode has no current equivalent.
async function rekeyHistoricalRows(rows, codeField = 'CardCode') {
  const m = await getCustomerMap()
  const out = []
  for (const r of rows) {
    const cc = m.historicalToCurrent.get(r[codeField])
    if (cc) out.push({ ...r, [codeField]: cc, _historical_code: r[codeField] })
  }
  return out
}

module.exports = {
  getCustomerMap,
  toHistoricalCode,
  toCurrentCode,
  rekeyHistoricalRows,
  normName
}
