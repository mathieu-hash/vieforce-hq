// Shared commercial filters for HQ dashboards.
// Region here means shipping/warehouse region unless an endpoint documents otherwise.

const { regionCaseSql } = require('./region-map')

const KA_SLPCODES = [2, 7, 24]
const SEGMENTS = new Set(['ALL', 'DIST', 'KA', 'PET'])

function normalizeRegion(region) {
  const r = String(region || 'ALL').trim()
  if (/^luzon$/i.test(r)) return 'Luzon'
  if (/^visayas$/i.test(r)) return 'Visayas'
  if (/^mindanao$/i.test(r)) return 'Mindanao'
  if (/^other$/i.test(r)) return 'Other'
  return 'ALL'
}

function normalizeSegment(segment) {
  const s = String(segment || 'ALL').trim().toUpperCase()
  if (s === 'DISTRIBUTION') return 'DIST'
  if (s === 'KEY_ACCOUNTS' || s === 'KEY ACCOUNTS') return 'KA'
  if (s === 'PET_CARE' || s === 'PET CARE') return 'PET'
  return SEGMENTS.has(s) ? s : 'ALL'
}

// regionCaseSql now comes from the canonical ./region-map (re-exported below so
// existing importers of business_filters keep working unchanged).

function regionFilterSql(region, lineAlias = 'T1') {
  const r = normalizeRegion(region)
  if (r === 'ALL') return ''
  return ` AND ${regionCaseSql(lineAlias)} = @region`
}

function kaPredicateSql(docAlias = 'T0') {
  const nameExpr = `UPPER(ISNULL(${docAlias}.CardName, ''))`
  return `(${docAlias}.SlpCode IN (${KA_SLPCODES.join(',')}) OR ${nameExpr} LIKE 'KA %' OR ${nameExpr} LIKE '% KA %' OR ${nameExpr} LIKE '% KEY ACCOUNT%')`
}

function petPredicateSql(docAlias = 'T0') {
  const nameExpr = `UPPER(ISNULL(${docAlias}.CardName, ''))`
  return `(${nameExpr} LIKE '%PET%' OR ${nameExpr} LIKE '%KEOS%' OR ${nameExpr} LIKE '%PLAISIR%' OR ${nameExpr} LIKE '%NOVOPET%')`
}

function segmentFilterSql(segment, docAlias = 'T0') {
  const s = normalizeSegment(segment)
  if (s === 'ALL') return ''
  const ka = kaPredicateSql(docAlias)
  const pet = petPredicateSql(docAlias)
  if (s === 'KA') return ` AND ${ka}`
  if (s === 'PET') return ` AND ${pet}`
  if (s === 'DIST') return ` AND NOT ${ka} AND NOT ${pet}`
  return ''
}

function segmentCaseSql(docAlias = 'T0') {
  return `CASE
    WHEN ${petPredicateSql(docAlias)} THEN 'PET'
    WHEN ${kaPredicateSql(docAlias)} THEN 'KA'
    ELSE 'DIST'
  END`
}

function filterMeta(region, segment) {
  return {
    region: normalizeRegion(region),
    region_basis: 'shipping_warehouse',
    segment: normalizeSegment(segment),
    segment_basis: 'SlpCode/name classifier; confirm official KA customer master'
  }
}

module.exports = {
  KA_SLPCODES,
  normalizeRegion,
  normalizeSegment,
  regionCaseSql,
  regionFilterSql,
  segmentCaseSql,
  segmentFilterSql,
  filterMeta
}
