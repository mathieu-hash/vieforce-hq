# Session strategy — Beta (SEC-03)

**Status:** Documented for Beta; implementation of signed/JWT sessions is **post-Beta** unless prioritized.

## Current behavior (`api/auth/login.js`, `js/auth.js`)

- Login verifies PIN server-side; response includes user shape stored client-side with **`expiresAt`** (24h TTL per server constant).
- Subsequent API calls send **`x-session-id: <users.id UUID>`** — validated in `verifySession` against `public.users` (active only).

## Beta mitigations (no code change required for sign-off)

| Risk | Mitigation |
|------|------------|
| UUID token theft | HTTPS only (Vercel + Cloud Run); short TTL; CSP reduces XSS surface (`vercel.json`) |
| Session fixation | Login replaces session entirely on success |
| Long-lived exposure | 24h TTL aligned with existing client behavior |

## Transport

- Browser → **HTTPS** only in production.
- **Never** send service role or PIN in query strings.

## Roadmap (post-Beta)

- Issue **signed session tokens** or Supabase JWT refresh flow — noted in `api/auth/login.js` header comments.
- Central **logout everywhere** + optional refresh rotation.

---

*Last updated: 2026-05-03*
