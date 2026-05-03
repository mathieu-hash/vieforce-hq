#!/usr/bin/env node
/**
 * Add VieForce HQ (and keep Patrol) on Supabase Auth redirect allow-list.
 *
 * Symptom if HQ is missing: after Google OAuth, Supabase shows a black page
 * "Error: Forbidden" — redirectTo is not in uri_allow_list.
 *
 * Patrol OAuth uses redirectTo → vieforce-patrol (must stay in uri_allow_list).
 * HQ OAuth uses redirectTo → vieforce-hq; Supabase **site_url** should be HQ so
 * GoTrue’s hostname check accepts HQ redirects (see supabase/auth GetReferrer).
 *
 * Usage (PowerShell):
 *   $env:SUPABASE_ACCESS_TOKEN = "<PAT from https://supabase.com/dashboard/account/tokens>"
 *   node scripts/patch-supabase-auth-url.mjs
 *
 * Optional overrides:
 *   SUPABASE_PROJECT_REF     (default: yolxcmeoovztuindrglk — must match js/supabase.js project)
 *   SUPABASE_AUTH_SITE_URL   auth site_url (default: https://vieforce-hq.vercel.app) — see header comment
 *   AUTH_URI_ALLOW_LIST      comma-separated patterns (default merges Patrol + HQ + localhost)
 */
const API = 'https://api.supabase.com'
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || 'yolxcmeoovztuindrglk'
// MUST be vieforce-hq hostname so GoTrue accepts redirect_to from HQ without relying on glob
// matching (shared project used to set this to Patrol → OAuth always returned to Patrol).
const SITE_URL = (
  process.env.SUPABASE_AUTH_SITE_URL ||
  process.env.PATROL_SITE_URL ||
  'https://vieforce-hq.vercel.app'
).replace(/\/$/, '')
const URI_ALLOW_LIST =
  process.env.AUTH_URI_ALLOW_LIST ||
  [
    'https://vieforce-patrol.vercel.app/**',
    'https://vieforce-hq.vercel.app/**',
    // Exact path avoids wildcard edge cases where redirect_to falls back to Site URL (Patrol).
    'https://vieforce-hq.vercel.app/index.html',
    'http://localhost:3000/**',
    'http://127.0.0.1:3000/**',
  ].join(',')

const token = process.env.SUPABASE_ACCESS_TOKEN
if (!token || !String(token).trim()) {
  console.error(
    'Missing SUPABASE_ACCESS_TOKEN.\n' +
      'Create a Personal Access Token: https://supabase.com/dashboard/account/tokens\n' +
      'Scopes: include project config / auth write for your org.\n' +
      'Then: $env:SUPABASE_ACCESS_TOKEN = "sbp_..." ; node scripts/patch-supabase-auth-url.mjs'
  )
  process.exit(1)
}

const body = {
  site_url: SITE_URL,
  uri_allow_list: URI_ALLOW_LIST,
}

const url = `${API}/v1/projects/${PROJECT_REF}/config/auth`
const res = await fetch(url, {
  method: 'PATCH',
  headers: {
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify(body),
})

const text = await res.text()
if (!res.ok) {
  console.error('PATCH failed', res.status, text)
  process.exit(1)
}
console.log('OK', res.status)
console.log('site_url →', body.site_url)
console.log('uri_allow_list →', body.uri_allow_list)
try {
  const j = JSON.parse(text)
  if (j && j.uri_allow_list) console.log('Response uri_allow_list:', j.uri_allow_list)
} catch (_) {
  console.log(text.slice(0, 500))
}
