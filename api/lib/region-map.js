// Canonical WhsCode → region map. SINGLE SOURCE OF TRUTH — every region
// classification (SQL CASE, JS lookup, WHERE filters) must derive from here so
// the app can never again disagree with itself about which region a plant is in.
//
// Confirmed by Mat 2026-07-03: BAC = Bacolod (Visayas), ALAE = Mindanao.
// This corrects the older hero-view map (which put BAC in Luzon / ALAE in
// Visayas AND silently dropped HBEXT/SOUTH/CAG/PFMIS into 'Other').

const PLANT_REGION = {
  // Luzon
  AC: 'Luzon', ACEXT: 'Luzon', PFMIS: 'Luzon', PFMCIS: 'Luzon',
  // Visayas
  HOREB: 'Visayas', HBEXT: 'Visayas', 'HBEXT-QA': 'Visayas', BAC: 'Visayas', ARGAO: 'Visayas',
  // Mindanao
  BUKID: 'Mindanao', SOUTH: 'Mindanao', CAG: 'Mindanao', ALAE: 'Mindanao', CCPC: 'Mindanao'
}

const REGIONS = ['Luzon', 'Visayas', 'Mindanao']

// JS lookup — returns 'Other' for any unmapped code.
function regionOfWhs(code) {
  return PLANT_REGION[String(code || '').trim()] || 'Other'
}

// Codes grouped by region, for building the SQL CASE (derived from PLANT_REGION
// so the SQL and JS can never drift apart).
function codesFor(region) {
  return Object.keys(PLANT_REGION).filter(c => PLANT_REGION[c] === region)
}

// SQL CASE expression mapping <alias>.<col> → region. `alias` is the table
// alias holding the plant column in the host query (e.g. 'T1', 'INV', 'W', 'T2').
// `col` defaults to 'WhsCode' so all existing callers are byte-identical; pass
// e.g. 'Warehouse' for tables (OWOR) whose plant column isn't named WhsCode.
function regionCaseSql(alias = 'T1', col = 'WhsCode') {
  const line = region =>
    `    WHEN ${alias}.${col} IN (${codesFor(region).map(c => `'${c}'`).join(',')}) THEN '${region}'`
  return `CASE\n${REGIONS.map(line).join('\n')}\n    ELSE 'Other'\n  END`
}

module.exports = { PLANT_REGION, REGIONS, regionOfWhs, regionCaseSql }
