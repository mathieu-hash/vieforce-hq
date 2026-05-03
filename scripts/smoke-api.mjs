#!/usr/bin/env node
/**
 * Staging / production API smoke (ENG-03). No secrets required.
 * Unauthenticated calls: expect 401 on protected routes, 401 on /api/diag (post Phase 1).
 *
 * Usage:
 *   HQ_API_URL=https://your-api.run.app node scripts/smoke-api.mjs
 *
 * Exit 0 if all probes match allowed statuses.
 */
const API_URL = (process.env.HQ_API_URL || process.env.API_URL || '').replace(/\/$/, '')
const TIMEOUT_MS = 15000

const PATHS = [
  { path: '/', allowed: [200] },
  // Gated diag: unauthenticated must not see SAP probes (401). 404 = DISABLE_DIAG=1.
  { path: '/api/diag', allowed: [401, 404] },
  { path: '/api/dashboard?period=MTD&region=ALL', allowed: [200, 401] },
  { path: '/api/sales?period=MTD&region=ALL', allowed: [200, 401] }
]

async function probe(rel) {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${API_URL}${rel}`, {
      signal: ctrl.signal,
      headers: { Accept: 'application/json' }
    })
    return res.status
  } finally {
    clearTimeout(t)
  }
}

async function main() {
  if (!API_URL) {
    console.error('Set HQ_API_URL (or API_URL) to the Cloud Run API base, e.g.')
    console.error('  HQ_API_URL=https://vieforce-hq-api-xxxxx.run.app node scripts/smoke-api.mjs')
    process.exit(2)
  }

  let failed = false
  for (const { path: rel, allowed } of PATHS) {
    let status
    try {
      status = await probe(rel)
    } catch (e) {
      console.error(`FAIL ${rel}: ${e.message}`)
      failed = true
      continue
    }
    if (!allowed.includes(status)) {
      console.error(`FAIL ${rel}: HTTP ${status} (expected one of ${allowed.join(',')})`)
      failed = true
    } else {
      console.log(`OK   ${rel}: HTTP ${status}`)
    }
  }

  process.exit(failed ? 1 : 0)
}

main()
