/**
 * Contract: Google OAuth return URL is chosen by each app's signInWithOAuth({ redirectTo }).
 * HQ → vieforce-hq.../auth/callback.html — Patrol → vieforce-patrol.../index.html
 * Supabase must allow-list both (see scripts/patch-supabase-auth-url.mjs).
 */
const { readFileSync, existsSync } = require('node:fs')
const { join } = require('node:path')
const { test } = require('node:test')
const assert = require('node:assert/strict')

const root = join(__dirname, '..')
const patrolAuthPath = join(root, '..', 'vieforce-patrol', 'js', 'auth.js')

test('HQ js/auth.js: Google redirect uses HQ callback only (never Patrol hostname)', () => {
  const auth = readFileSync(join(root, 'js', 'auth.js'), 'utf8')
  assert.match(auth, /vieforce-hq\.vercel\.app\/auth\/callback\.html/)
  assert.match(auth, /window\.location\.origin/)
  assert.doesNotMatch(auth, /host\s*===\s*['"]localhost['"][\s\S]*vieforce-hq\.vercel\.app/)
  assert.doesNotMatch(auth, /vieforce-patrol\.vercel\.app/)
  assert.match(auth, /skipBrowserRedirect:\s*true/)
  assert.match(auth, /verifyHqOAuthAuthorizeUrl/)
  assert.match(auth, /PATROL_OAUTH_HOST_MARKER/)
})

test('HQ js/auth.js: login and google-bridge follow same localhost API base as api.js', () => {
  const auth = readFileSync(join(root, 'js', 'auth.js'), 'utf8')
  assert.match(auth, /function getAuthApiBase\(/)
  assert.match(auth, /getAuthLoginUrl\(\)/)
  assert.match(auth, /getGoogleBridgeUrl\(\)/)
  assert.doesNotMatch(auth, /var AUTH_API = 'https:\/\/vieforce-hq-api/)
})

test('HQ api/_auth.js: session verify prefers service role (RLS-safe)', () => {
  const auth = readFileSync(join(root, 'api', '_auth.js'), 'utf8')
  assert.match(auth, /SUPABASE_SERVICE_ROLE_KEY \|\| process\.env\.SUPABASE_ANON_KEY/)
  assert.match(auth, /getSessionSupabase/)
})

test('HQ index.html: localhost Google login does not bounce to production', () => {
  const index = readFileSync(join(root, 'index.html'), 'utf8')
  assert.doesNotMatch(index, /localhost[\s\S]*vieforce-hq\.vercel\.app\/index\.html#hq_google=1/)
  assert.match(index, /loginWithGoogle\(\)/)
})

test('Patrol js/auth.js: Google redirect uses Patrol origin (sibling repo)', {
  skip: !existsSync(patrolAuthPath),
}, () => {
  const patrolAuth = readFileSync(patrolAuthPath, 'utf8')
  assert.match(patrolAuth, /vieforce-patrol\.vercel\.app/)
  assert.match(patrolAuth, /return\s+origin\s+\+\s+['"]\/index\.html['"]/)
  assert.doesNotMatch(patrolAuth, /vieforce-hq\.vercel\.app/)
})

test('patch-supabase-auth-url.mjs: allow-list includes both apps', () => {
  const patch = readFileSync(join(root, 'scripts', 'patch-supabase-auth-url.mjs'), 'utf8')
  assert.match(patch, /vieforce-patrol/)
  assert.match(patch, /vieforce-hq/)
  assert.match(patch, /localhost:8080/)
})
