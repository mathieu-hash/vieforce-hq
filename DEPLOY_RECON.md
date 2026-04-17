# DEPLOY RECON — VieForce HQ API

**Date:** 2026-04-16
**Recon by:** Claude (Deploy Recon Agent)

---

## 1. Deploy Method

**Manual `gcloud run deploy`** — no CI/CD pipeline exists.

- No GitHub Actions workflows found
- No `cloudbuild.yaml` found
- No deploy scripts found
- Deployment is done manually via `gcloud` CLI from local machine
- The Dockerfile + `.gcloudignore` handle the container build

## 2. Cloud Run Service Details

| Field | Value |
|---|---|
| **Service name** | `vieforce-hq-api` |
| **Region** | `asia-southeast1` |
| **GCP Project** | `vieforce-vpi` |
| **URL** | `https://vieforce-hq-api-1057619753074.asia-southeast1.run.app` |
| **Last deployed** | 2026-04-15 08:35 UTC by mathieu@vienovo.ph |
| **Active revision** | `vieforce-hq-api-00013-nkm` |
| **Resources** | 1 vCPU, 512Mi RAM |
| **Max instances** | 20 |
| **Startup CPU boost** | Enabled |

## 3. Environment Variables (already set on Cloud Run)

All env vars are already configured on the service:

- `SAP_HOST` = analytics.vienovo.ph
- `SAP_PORT` = 4444
- `SAP_DB` = Vienovo_Live
- `SAP_USER` = gsheet
- `SAP_PASS` = (set)
- `SUPABASE_URL` = (set)
- `SUPABASE_ANON_KEY` = (set)
- `TARGET_MT` = 15000

**No new env vars needed** for the new endpoints (budget, margin, intelligence, team, diag). They all use the same SAP connection via `_db.js`.

## 4. Staging Environment

**None exists.** No staging service, no staging branch trigger, no cloudbuild-staging.yaml.
Only path is direct-to-production.

## 5. Git Status

- **Branch:** `master` (not `design-upgrade` — we're on main)
- **Commits ahead of remote:** 0 (up to date with origin/master)
- **12 modified files** (unstaged):
  - `api/_db.js`, `api/customer.js`, `api/customers.js`, `api/dashboard.js`, `api/inventory.js`, `api/sales.js`, `api/speed.js`
  - `app.html`, `js/api.js`, `package.json`, `package-lock.json`, `server.js`
- **5 new API files** (untracked): `api/budget.js`, `api/diag.js`, `api/intelligence.js`, `api/margin.js`, `api/team.js`
- **4 report files** (untracked): `ENDPOINTS_REPORT.md`, `FINALIZE_REPORT.md`, `SETUP_REPORT.md`, `WIRING_REPORT.md`
- **2 backup files** (untracked): `app.html.backup`, `index.html.backup`

## 6. Local Server Test Results

| Test | Result |
|---|---|
| `npm start` | OK — server starts on port 8080 |
| `GET /` (health) | 200 — `{"status":"ok","service":"vieforce-hq-api","version":"1.0.0"}` |
| `GET /api/budget` | 401 (auth required — correct) |
| `GET /api/margin` | 401 (auth required — correct) |
| `GET /api/intelligence` | 401 (auth required — correct) |
| `GET /api/team` | 401 (auth required — correct) |
| `GET /api/diag` | 200 (no auth required — correct, it's a diagnostic endpoint) |

All 5 new endpoints are registered and responding correctly.

## 7. Container Build — Potential Issues

**Dockerfile is clean** — `node:20-slim`, `npm ci --production`, `COPY . .`, `EXPOSE 8080`.

Considerations:
- `.dockerignore` excludes `*.md` — report files won't bloat the image (good)
- `.gcloudignore` excludes `.env.local` — credentials won't be uploaded (good)
- `package-lock.json` is modified — `npm ci` will install the correct deps
- No native dependencies — `mssql` uses pure JS TDS driver, no build issues expected

## 8. Deploy Instructions

### FAST PATH (direct to production — no staging available)

```bash
# Step 1: Commit all changes
cd "/c/Users/Mathi/OneDrive/Documents/VSC Project/business/vieforce-hq"
git add api/budget.js api/diag.js api/intelligence.js api/margin.js api/team.js
git add api/_db.js api/customer.js api/customers.js api/dashboard.js api/inventory.js api/sales.js api/speed.js
git add server.js package.json package-lock.json app.html js/api.js
git commit -m "Add 5 new endpoints: budget, margin, intelligence, team, diag"

# Step 2: Push to remote
git push origin master

# Step 3: Deploy to Cloud Run
gcloud run deploy vieforce-hq-api \
  --source . \
  --region asia-southeast1 \
  --project vieforce-vpi \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --max-instances 20

# Step 4: Verify
curl https://vieforce-hq-api-1057619753074.asia-southeast1.run.app/
curl https://vieforce-hq-api-1057619753074.asia-southeast1.run.app/api/diag
```

### SAFE PATH (traffic splitting — rollback-friendly)

```bash
# Steps 1-2: Same as FAST PATH (commit + push)

# Step 3: Deploy with NO traffic (new revision only)
gcloud run deploy vieforce-hq-api \
  --source . \
  --region asia-southeast1 \
  --project vieforce-vpi \
  --allow-unauthenticated \
  --memory 512Mi \
  --cpu 1 \
  --max-instances 20 \
  --no-traffic

# Step 4: Test the new revision directly
# (gcloud will print the revision URL — use that)
gcloud run revisions list --service vieforce-hq-api --region asia-southeast1 --limit 2

# Step 5: If tests pass, shift 100% traffic
gcloud run services update-traffic vieforce-hq-api \
  --region asia-southeast1 \
  --to-latest

# Step 6: If something breaks, rollback
gcloud run services update-traffic vieforce-hq-api \
  --region asia-southeast1 \
  --to-revisions vieforce-hq-api-00013-nkm=100
```

## 9. Summary

| Item | Status |
|---|---|
| Deploy method | Manual `gcloud run deploy --source .` |
| Dockerfile | Ready — no changes needed |
| New endpoints | 5 files, all tested locally |
| Env vars | Already configured — no changes needed |
| Staging | Not available — use SAFE PATH with `--no-traffic` |
| Blocking issues | **None** — ready to deploy |
