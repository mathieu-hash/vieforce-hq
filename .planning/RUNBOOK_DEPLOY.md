# Deploy & operations runbook (OPS-01 — OPS-03)

## Deploy order (OPS-01)

1. **Supabase** — apply pending SQL from `migrations/` (RLS, locks). Confirm with `supabase db push` or dashboard SQL if not automated.  
2. **HQ API (Cloud Run)** — deploy container/env vars **before** or **with** traffic switch; verify `GET /` returns JSON health.  
3. **Static UI (Vercel)** — deploy after API if `js/api.js` base URL unchanged; if API URL changed, update client first then redeploy.  

## Rollback

| Layer | Action |
|-------|--------|
| Cloud Run | Revisions → route 100% traffic to previous revision |
| Vercel | Promote previous deployment from dashboard |
| Supabase | Avoid destructive migrations without backup; use forward-fix for data |

## Who to page

- **API / SAP down:** owner of SAP VPN + Cloud Run project  
- **Auth / users:** whoever holds Supabase project admin  
- **Vercel / DNS:** web ops contact  

Record actual names in your internal wiki (not committed).

---

## Pilot load & sizing (OPS-02)

**Defaults in repo:** `api/_db.js` pool `max: 10`, request timeout `45000` ms.

| Pilot scale | Suggestion |
|-------------|------------|
| &lt; 50 concurrent HQ users | Cloud Run **min instances 0–1**, concurrency per instance per GCP guidance |
| Demo days / leadership reviews | Temporarily **min instances 1**, watch SAP SQL latency |

Validate under pilot: Cloud Run CPU/memory, SAP `requestTimeout` errors in logs.

---

## Monitoring (OPS-03)

| Option | Beta recommendation |
|--------|---------------------|
| **Cloud Logging** | Required — filter `stderr` / `[svc-auth]` / `[scope]` |
| **Sentry** (optional) | Wrap Express `server.js` error handler if adopted — not bundled by default |
| **Uptime** | External ping `GET /` every 5 min |

**Decision for Beta:** rely on **Cloud Logging + optional uptime check**; Sentry deferred unless incident rate warrants.

---

*Last updated: 2026-05-03*
