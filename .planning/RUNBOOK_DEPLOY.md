# Deploy & operations runbook (OPS-01 — OPS-03)

## Google Sign-In (HQ + Patrol)

Shared Supabase project: enable **Google** provider under Authentication → Providers (already on for Patrol).

**Redirect URLs** (Authentication → URL Configuration → **Redirect URLs**) must allow **both** apps. If HQ is missing, Google OAuth ends on a Supabase page **“Error: Forbidden”** (HTTP 403) with an empty **ID** — that is *not* the google-bridge API; it is the redirect URL blocked before your app loads.

Add at least:

- `https://vieforce-hq.vercel.app/**` (covers `index.html` and query params)
- `https://vieforce-patrol.vercel.app/**` (Patrol)

**One-shot via Management API** (merges both origins; requires `SUPABASE_ACCESS_TOKEN`):

`npm run fix:supabase-auth-url` (see `scripts/patch-supabase-auth-url.mjs`).

**User records:** `public.users.email` must match the person’s **@vienovo.ph** Google email or bridge returns *not linked*. Manager/staff roles allowed for Google on HQ: `dsm`, `rsm`, `director`, `exec`, `admin`, `ceo`, `evp`, `marketing` (TSR/champion: phone + PIN).

**API:** `POST /api/auth/google-bridge` on Cloud Run validates the Supabase JWT and returns the same session shape as PIN login.

---

## Auto-deploy from `master`

| Target | How |
|--------|-----|
| **Static UI (Vercel)** | Git repository is connected to the Vercel project. GitHub **default branch is `master`** — pushes to `master` trigger production deployments. Confirm in Vercel → Project → Settings → Git: production branch matches `master`. |
| **API (Cloud Run)** | Workflow **`.github/workflows/deploy-cloud-run.yml`** runs on every push to `master`. Uses GitHub secret **`GCP_SA_KEY`** (JSON for **`github-vieforce-hq-deploy@vieforce-vpi.iam.gserviceaccount.com`** or a replacement SA with the same duties). **GCP setup:** enable **Cloud Resource Manager API** on the project; grant the SA `run.admin`, `cloudbuild.builds.editor`, `iam.serviceAccountUser`, `artifactregistry.writer`, and **`storage.admin` on bucket `gs://run-sources-vieforce-vpi-asia-southeast1`** (Cloud Run’s source staging bucket uses legacy ACLs tied to `projectEditor`, so project-level `storage.admin` alone is not enough). After deploy, the workflow runs **`gcloud run services update-traffic … --to-latest`**. |

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
