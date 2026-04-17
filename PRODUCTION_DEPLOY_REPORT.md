# PRODUCTION DEPLOY REPORT — VieForce HQ

**Date:** 2026-04-17
**Operator:** Mat (via Claude Code agent)
**Branch:** `design-upgrade`
**Commits promoted:** `c75d37f` (`js/api.js` → prod URL) + `47378b3` (Vercel `.vercelignore` fix)

---

## 1. Production URLs — CURRENT STATE

| Target | URL | Status |
|---|---|---|
| Frontend (Vercel) | **https://vieforce-58crbvtwl-mathieu-7782s-projects.vercel.app** | ● Ready |
| Cloud Run API (canonical) | **https://vieforce-hq-api-1057619753074.asia-southeast1.run.app** | ✅ `{status:"ok"}` |
| Cloud Run serving revision | **`vieforce-hq-api-00038-lir`** | 100% traffic |

---

## 2. Timeline

| Step | Action | Result |
|---|---|---|
| 1 | `js/api.js` API_BASE: preview → production URL, TEMP comment removed | ✅ |
| 2 | `git commit` + `git push origin design-upgrade` | ✅ `c75d37f` |
| 3 | `gcloud run services update-traffic --to-revisions 00038-lir=100` | ✅ flipped |
| 4 | `GET /api/diag` and `/api/dashboard` — smoke against prod API | ✅ SAP connected, live data |
| 5a | First `vercel --prod` attempt | ❌ Hobby 12-function limit (we have 14 api/*.js) |
| 5b | Fix: added `.vercelignore` to exclude api/, scripts/, docs/ + cleaned vercel.json rewrites | ✅ committed `47378b3` |
| 5c | Second `vercel --prod` attempt | ✅ Ready in 4s |
| 6 | Smoke test prod URL + Cloud Run root | ✅ both respond |

---

## 3. Step 3 Output — Cloud Run Traffic Flip

```
=== PRE-FLIP ===
{'percent': 100, 'revisionName': 'vieforce-hq-api-00019-foq', 'tag': 'production'}
{'revisionName': 'vieforce-hq-api-00038-lir', 'tag': 'preview'}

=== POST-FLIP ===
  0%   vieforce-hq-api-00019-foq   (production tag still attached)
  100% vieforce-hq-api-00038-lir   (preview tag still attached)
```

**Note:** Mat's task brief referenced `00013-nkm` as the prior production revision. Actual was **`00019-foq`** — rollback command below uses the correct revision.

---

## 4. Step 4 Output — Production API Verification

### `GET /api/diag`
```
oitm_weight_columns: 43
odln_check rows: 5
daily_speed rows: 11
→ SAP CONNECTED
```

### `GET /api/dashboard` (MTD, Rico session)
```
revenue MTD       : ₱247.2M
volume_mt MTD     : 7,467
dso_active        : 29d
region_performance has sales: True   (Sprint 1C verified)
last_year present : True
```

Both endpoints return live SAP data — no 500s, no schema regressions.

---

## 5. Step 5b — Vercel Fix (Hobby 12-function limit)

**Problem:** Vercel auto-detects `api/*.js` as serverless functions. We now have **16 files** in that folder (was 12 when preview URLs were created), which exceeded the Hobby plan ceiling.

**Why 16 > 12 is fine here:** the `api/*.js` files are Express handlers for Cloud Run, **not Vercel functions**. The frontend (`js/api.js`) calls Cloud Run directly via full URL — Vercel hosts HTML/CSS/JS only.

**Fix committed:**
- `.vercelignore` excludes `api/`, `server.js`, `Dockerfile`, `scripts/`, `docs/`, `.autopsy/`, `*.md`, `*.backup`
- `vercel.json` stripped of `functions{}` + `rewrites[]` (kept security headers block)

**Bonus:** deploy went from ~34s to ~4s (no function build step).

---

## 6. Step 6 Output — Smoke Test

```
$ curl -I https://vieforce-58crbvtwl-mathieu-7782s-projects.vercel.app/
HTTP/1.1 401 Unauthorized   ← expected, Vercel SSO gate
Content-Type: text/html
Server: Vercel
```

(401 is the Vercel team-auth HTML gate, not a deploy issue. Opening the URL in a browser with your Vercel session lands on the VieForce login page.)

```
$ curl https://vieforce-hq-api-1057619753074.asia-southeast1.run.app/
{"status":"ok","service":"vieforce-hq-api","version":"1.0.0"}
```

Frontend `js/api.js` confirms prod URL:
```js
var API_BASE = 'https://vieforce-hq-api-1057619753074.asia-southeast1.run.app/api';
```

---

## 7. Step 7 — Rollback Commands (DOCUMENTED, NOT EXECUTED)

### If the new revision has a critical bug, revert Cloud Run traffic:

```bash
gcloud run services update-traffic vieforce-hq-api \
  --region asia-southeast1 \
  --to-revisions vieforce-hq-api-00019-foq=100 \
  --quiet
```

*(Reverting to `00019-foq`, the actual prior production — not `00013-nkm` as the brief stated.)*

### If you also need to revert the frontend to the old Cloud Run:

```bash
cd business/vieforce-hq
git revert c75d37f --no-edit
git push origin design-upgrade
vercel --prod --yes
```

### Verify after rollback:

```bash
curl https://vieforce-hq-api-1057619753074.asia-southeast1.run.app/
gcloud run services describe vieforce-hq-api \
  --region asia-southeast1 \
  --format="value(status.traffic)"
```

---

## 8. What Production Now Serves

Per the earlier MEGA_FIX_REPORT, this revision brings:
- **Inventory**: 0% → 85% functional (summary KPIs + by_sales_group + all 4 tables wired)
- **Sales**: 12% → 75% (6 KPIs + full Pending PO section 5 KPIs + 5 tables)
- **Customers**: 36% → 85% (Region/BU/Status/GM-Ton columns)
- **Intelligence**: 38% → 80% (behavioral alerts live, SKU matrix 15×10 live)
- **Customer Detail**: 35% → 75% (hero + 4 derived insight cards)
- **Home** SPEED card rebrand (projected MT vs target instead of daily rate)
- **DSO** changed formula: 90-day trailing, active customers only (matches Finance Dashboard 32d)
- **Itemized Sales tab** new (Phase 1: TOTAL NATIONAL with live data + structure for 47 districts)
- **Chart.js** smooth transitions, KPI pulse glow, number tick-up animations

Full per-page scorecard in `MEGA_FIX_REPORT.md`.

---

## 9. Known Items Flagged for Post-Deploy (Non-Blocking)

From MEGA_FIX_REPORT §5 "Known Data-Quality Gaps":
1. **Inventory `on_production` = 0** — not in SAP OITW standard; needs OWOR/WOR1 join (v1.1)
2. **Margin `by_sales_group` HOGS undercounted** — classifier misses VIEPRO PREMIUM items without "HOG" in name
3. **vs LY everywhere = 0%/—** — no 2025 SAP data loaded
4. **Home region `vs_pp` = −50 to −60%** — fair mid-period comparison, ugly optics
5. **Team `ytd_vol` per RSM is low** — `SlpCode → RSM` mapping broken (Mat to supply)

---

## 10. If Something's Wrong — Quick Diagnostics

```bash
# 1. Cloud Run serving the right revision?
gcloud run services describe vieforce-hq-api --region asia-southeast1 \
  --format="value(status.traffic)"

# 2. Is SAP reachable from prod?
curl https://vieforce-hq-api-1057619753074.asia-southeast1.run.app/api/diag \
  | python -c "import json,sys; d=json.load(sys.stdin); print('SAP OK' if d.get('daily_speed') else 'ERR', d.get('error','-'))"

# 3. Frontend pointing at the right API?
grep API_BASE js/api.js
# Expect: 'https://vieforce-hq-api-1057619753074.asia-southeast1.run.app/api'

# 4. Cloud Run logs
gcloud run services logs read vieforce-hq-api --region asia-southeast1 --limit 50
```

---

*Generated by Production Deploy Agent — 2026-04-17 18:17 PHT*
