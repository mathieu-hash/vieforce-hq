// Warehouse / internal-transfer CardCodes that pollute customer-facing alerts.
// These are either:
//   - exact WhsCode matches (present in OWHS)
//   - internal IT/PD/QA mirrors of warehouses
//   - known internal transfer accounts (PFMIS, etc.)
//
// Used by: intelligence.js, customers.js, dashboard.js, margin.js, search.js.
//
// NOTE: In addition to this static list, callers that can afford one extra
// query should also pull `SELECT WhsCode FROM OWHS` at request time and merge
// via `mergeDynamicWhsCodes()` below — that future-proofs against new plants.

const NON_CUSTOMER_CODES = new Set([
  // Production warehouses (also in OWHS)
  'AC', 'ACEXT', 'BAC',
  'HOREB', 'ARGAO', 'ALAE',
  'BUKID', 'CCPC',
  // Known IT / Quality / PD mirror warehouses
  'HBEXT', 'HBEXT-QA',
  'HOREB-IT', 'HOREB-PD',
  'BAC-IT',
  'BUKID-IT',
  // Internal transfer / supplier-side accounts that appear in OCRD
  'PFMIS'
])

function isNonCustomer(code) {
  if (!code) return false
  const up = String(code).toUpperCase().trim()
  if (NON_CUSTOMER_CODES.has(up)) return true
  // Defensive pattern: any CardCode that is all-caps short and matches
  // a warehouse suffix like "-IT", "-PD", "-QA" → treat as non-customer.
  if (/^[A-Z]{2,8}(-IT|-PD|-QA|-EXT)$/.test(up)) return true
  return false
}

/**
 * Some internal-transfer "customers" were given normal CA-prefixed codes
 * at SAP setup (e.g. CCPC is CardCode=CA000125). These leak into alerts
 * even after isNonCustomer(CardCode) passes. Check the CardName against
 * the same warehouse vocabulary.
 */
function isNonCustomerByName(name) {
  if (!name) return false
  const n = String(name).toUpperCase().trim()
  // Exact match against the code list (e.g. "CCPC", "HOREB")
  if (NON_CUSTOMER_CODES.has(n)) return true
  // Name starts with a known warehouse token + separator
  for (const c of NON_CUSTOMER_CODES) {
    if (n === c) return true
    if (n.startsWith(c + ' ') || n.startsWith(c + '-') || n.startsWith(c + '_')) return true
  }
  return false
}

/** True if either the CardCode or CardName matches a warehouse/internal pattern. */
function isNonCustomerRow(code, name) {
  return isNonCustomer(code) || isNonCustomerByName(name)
}

// Filter an array of row-like objects using a code extractor.
function excludeNonCustomers(rows, keyFn, nameFn) {
  const k = keyFn || (r => r.card_code || r.CardCode || r.customer_code || r.code)
  const n = nameFn || (r => r.name || r.CardName || r.customer_name || r.customer)
  return rows.filter(r => !isNonCustomerRow(k(r), n(r)))
}

// Merge any additional codes (typically from `SELECT WhsCode FROM OWHS`) into
// the static set for the life of this process. Safe to call multiple times.
function mergeDynamicWhsCodes(codes) {
  if (!Array.isArray(codes)) return
  for (const c of codes) {
    if (c) NON_CUSTOMER_CODES.add(String(c).toUpperCase().trim())
  }
}

// SQL fragment for use in parameterized MSSQL queries. Returns
// e.g. "AND T0.CardCode NOT IN ('AC','ACEXT',...)"; safe because
// the list is a developer-curated literal, not user input.
function sqlNotInClause(column) {
  const quoted = [...NON_CUSTOMER_CODES].map(c => `'${c.replace(/'/g, "''")}'`).join(',')
  return `AND ${column} NOT IN (${quoted})`
}

module.exports = {
  NON_CUSTOMER_CODES,
  isNonCustomer,
  isNonCustomerByName,
  isNonCustomerRow,
  excludeNonCustomers,
  mergeDynamicWhsCodes,
  sqlNotInClause
}
