---
mapped_date: 2026-05-03
repo: vieforce-hq
focus: quality
---

# Conventions — VieForce HQ Desktop

## Style

- **CommonJS** modules: `require` / `module.exports` on server; browser code uses `var` / function declarations in several legacy files (no bundler in default path).
- **Async handlers:** API modules export `async (req, res) =>` with try/catch only where needed; some rely on express error propagation.
- **Logging:** `console.log` / `console.warn` for operational traces (e.g. `[svc-auth]`, `[scope]`).

## Error handling

- API routes return JSON error bodies with appropriate HTTP status (401 / 403 / 404 / 429 / 500) — especially `api/auth/login.js` with **generic** invalid-credentials messages to prevent user enumeration.
- **Rate limiting:** In-memory `Map` per instance in `login.js` (documented limitation for multi-instance scale-out).

## Security-oriented patterns

- **Parameterized SQL:** `api/_db.js` `bindParams` — avoid string-concatenated user input in SQL; role/region comment in `_auth.js` documents admin-set fields.
- **Timing-safe compare:** PIN verification uses `crypto.timingSafeEqual` pattern in `api/auth/login.js`.
- **Service token:** `verifyServiceToken` uses `crypto.timingSafeEqual` against `HQ_SERVICE_TOKEN`.

## Authorization patterns (know the split)

- **`applyRoleFilter`:** Legacy SQL fragment helper — currently broad for most roles (see TODO).
- **`scopeForUser` / `_scope.js`:** Preferred for Patrol-proxy and newer scoped endpoints — encodes org hierarchy in Supabase and maps to SAP.

When adding endpoints, **choose one model deliberately** and add tests in `tests/*-scope.test.js` or `tests/scope.test.js`.

## Frontend

- `js/api.js` strips `undefined` query params to avoid `?period=undefined` hitting the API.
- Cache-buster `_t` on all API calls to avoid stale CDN/browser cache.
