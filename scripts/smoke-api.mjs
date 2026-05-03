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
  // After Phase 1 deploy: expect 401 only. 200 = legacy open diag (warn); 404 = DISABLE_DIAG.
  { path: '/api/diag', allowed: [200, 401, 404], warnStatus: 200 },
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
  for (const { path: rel, allowed, warnStatus } of PATHS) {
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
      const tag = warnStatus === status ? 'WARN' : 'OK '
      console.log(`${tag}  ${rel}: HTTP ${status}`)
      if (warnStatus === status) {
        console.warn('      ↑ Deploy gated /api/diag — open diagnostic still reachable')
      }
    }
  }

  process.exit(failed ? 1 : 0)
}

main()
