// Canonical WhsCode → region map. SINGLE SOURCE OF TRUTH — every region
// classification (SQL CASE, JS lookup, WHERE filters) must derive from here so
// the app can never again disagree with itself about which region a plant is in.
//
// Confirmed by Mat 2026-07-03: BAC = Bacolod (Visayas), ALAE = Mindanao.
//
// Matching is by BASE plant code: SAP has sub-warehouses suffixed with the bin
// type (e.g. HOREB-IT intransit, BAC-QA quality, AC-PD production). These belong
// to the same region as their base plant, so we strip the "-<suffix>" and match
// the base. Without this ~₱38M AR + ~430 MT of real stock (incl. HOREB-IT 306 MT)
// fell into a meaningless "Other" region. Genuinely region-less codes
// (CONS = consignment, ACOW) stay 'Other'.

const PLANT_REGION = {
  // Luzon
  AC: 'Luzon', ACEXT: 'Luzon', PFMIS: 'Luzon', PFMCIS: 'Luzon',
  // Visayas
  HOREB: 'Visayas', HBEXT: 'Visayas', BAC: 'Visayas', ARGAO: 'Visayas',
  // Mindanao
  BUKID: 'Mindanao', SOUTH: 'Mindanao', CAG: 'Mindanao', ALAE: 'Mindanao', CCPC: 'Mindanao'
}

const REGIONS = ['Luzon', 'Visayas', 'Mindanao']

// Strip the "-<suffix>" bin qualifier to get the base plant code.
function baseCode(code) {
  const c = String(code || '').trim().toUpperCase()
  const dash = c.indexOf('-')
  return dash > 0 ? c.slice(0, dash) : c
}

// JS lookup — exact match first, then base plant code; 'Other' if unmapped.
function regionOfWhs(code) {
  const c = String(code || '').trim().toUpperCase()
  return PLANT_REGION[c] || PLANT_REGION[baseCode(c)] || 'Other'
}

// Codes grouped by region, for building the SQL CASE (derived from PLANT_REGION
// so the SQL and JS can never drift apart).
function codesFor(region) {
  return Object.keys(PLANT_REGION).filter(c => PLANT_REGION[c] === region)
}

// SQL CASE mapping <alias>.<col> → region, matching on the BASE plant code
// (everything before the first '-'). `alias` is the table alias holding the
// plant column; `col` defaults to 'WhsCode' (pass 'Warehouse' for OWOR).
function regionCaseSql(alias = 'T1', col = 'WhsCode') {
  const c = `${alias}.${col}`
  // Base = substring before first '-', else the whole code.
  const base = `CASE WHEN CHARINDEX('-', ${c}) > 0 THEN LEFT(${c}, CHARINDEX('-', ${c}) - 1) ELSE ${c} END`
  const line = region =>
    `    WHEN ${base} IN (${codesFor(region).map(x => `'${x}'`).join(',')}) THEN '${region}'`
  return `CASE\n${REGIONS.map(line).join('\n')}\n    ELSE 'Other'\n  END`
}

module.exports = { PLANT_REGION, REGIONS, baseCode, regionOfWhs, regionCaseSql }
