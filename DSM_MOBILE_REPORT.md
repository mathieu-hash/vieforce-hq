# DSM MOBILE HOME — Messenger-Feel Dashboard

**Date:** 2026-04-18
**Branch:** `design-upgrade` @ `415623c`
**Cloud Run prod:** `vieforce-hq-api-00063-zit` — **100% production traffic** ✓
**Vercel prod:** https://vieforce-hq.vercel.app ✓

---

## 1 · Summary

A fifth role persona landed: **DSM**. District Sales Managers now land on a mobile-first dashboard that blends SAP distributor data with Patrol field data. Everything is scoped to the DSM's own accounts via `OSLP.SlpName LIKE session.name` and to their own TSRs via `users.manager_id = session.id`.

Look & feel: **Messenger**. Light #F0F2F5 canvas, white cards with soft rounded corners, Facebook-blue → purple gradient hero, a bottom tab bar, and a slide-up "More" sheet — very consumer-app, very thumb-friendly.

The design follows the established EVP mobile pattern, but lives entirely under `body.role-dsm` so EVP/CEO/RSM/TSR/admin experiences are untouched.

---

## 2 · Files created / modified

```
NEW  api/dsm-home.js         298 lines   Aggregation endpoint: SAP + Patrol
NEW  css/dsm-home.css        276 lines   Messenger-style stylesheet
NEW  js/dsm-home.js          274 lines   Loader + 6 renderers + More sheet

MOD  server.js               +2 lines    Mount /api/dsm/home
MOD  js/api.js               +1 line     getDsmHome() wrapper
MOD  app.html                +280 lines  Page markup (pg-dsm-home), bottom nav,
                                         More sheet, <link> + <script> tags,
                                         sidebar link (#nav-dsm), initApp
                                         routing branch, loadPage case.
```

Total: **+1,146 lines, 6 files touched.** Non-intrusive — zero breaking changes to the 4 existing role experiences.

---

## 3 · `/api/dsm/home` — backend contract

```
GET /api/dsm/home
Headers: x-session-id: <uuid>        ← role=dsm
Response (120s cache, user-scoped):

{
  dsm: { id, name, district, region, tsr_count, distributor_count },
  sales: {
    mtd_revenue, mtd_volume_mt,
    prev_period_revenue, prev_period_volume_mt, vs_pp_pct,
    target, target_pct,
    ytd_revenue, ytd_volume_mt
  },
  kpis: {
    distributors_count, active_tsrs, total_tsrs,
    ar_overdue_amount, ar_overdue_count, conversions_mtd
  },
  ar: { total_open, overdue_amount, overdue_count },
  distributors: [ { code, name, mtd_revenue, mtd_volume_mt, mtd_gm, ar_overdue } × 5 ],
  tsrs: [ { id, name, phone, district, territory,
             visits_today, total_stores, active_today } ],
  conversions_mtd: 0,
  coaching: {
    urgent:   [ { tsr_id, tsr_name, message } ],   // idle TSRs with ≥3 stores
    positive: [ { tsr_id, tsr_name, message } ],   // high-visit days
    push:     [ { tsr_id, tsr_name, message } ]    // TSRs with 0 stores
  },
  critical: {
    ar_overdue:                [ { code, name, overdue_amount, days_overdue } × 5 ],
    at_risk_stores:            [],                  // v1.1 Patrol health
    idle_tsrs:                 [ { id, name, total_stores } × 5 ],
    negative_margin_customers: [ { code, name, gp, gp_pct } × 5 ]
  },
  meta: {
    sap_matched_rows, patrol_available, patrol_error, generated_at
  }
}
```

### SQL scope
Every SAP query is narrowed by `UPPER(OSLP.SlpName) LIKE '%' + UPPER(@dsmName) + '%'`, so a DSM sees only the customers whose invoices carry their SlpName. `@dsmName` comes directly from the authenticated session (never from the URL). Warehouse CardCodes/Names are filtered via the shared `isNonCustomerRow()` helper (CCPC fix from the silence-system sprint).

### Patrol side
Uses the same Supabase client as login. Reads:
- `users` where `manager_id = <dsm.id>` AND `role='tsr'`
- `visits` where `visited_at >= today PH midnight` (single batch `.in(tsr_ids)`)
- `stores` where `assigned_tsr IN (tsr_ids)` (single batch call)

All three are wrapped in a `try`-with-empty-fallback pattern — if a Patrol table or column isn't yet migrated on the Supabase project, the endpoint returns `meta.patrol_available: false` and the UI shows a helpful zero-state rather than a 500.

### Cache
Key = `dsm_home_<session.id>` · TTL = **120 s**. Short because a DSM home is a high-touch dashboard and field activity changes minute-by-minute.

### Live smoke (prod rev 00063-zit)
```
Session:  Rico Abante (TSR test user)
Result:   dsm {id, name='Rico Abante', district='Metro Manila', region='Luzon'}
          sales {all zero}             ← expected: Rico is TSR not DSM, no OSLP.SlpName match
          meta.patrol_available: true  ← Patrol schema OK
          meta.sap_matched_rows: 0     ← 0 invoices carry his SlpName (correct)

All 10 existing endpoints (dashboard/sales/ar/inventory/speed/customers/margin/
intelligence/team/silenced) verified HTTP 200 on the same revision.
```

Once a real DSM signs in, the numbers populate automatically.

---

## 4 · Frontend — `pg-dsm-home`

### Layout stack (top → bottom)
```
┌───────────────────────────────────┐
│ Rico Abante            [📊 DSM]   │   dsm-hdr (name + sub-line + gradient badge)
│ DSM · Metro Manila · 4 TSRs · 12 distributors
├───────────────────────────────────┤
│ ⚠  3 accounts overdue · ₱2.1M …   │   dsm-alert  (conditional)
├───────────────────────────────────┤
│ 💰 DISTRIBUTOR SALES · MTD        │
│ ₱4.8M                             │
│ ↑ 8.4% vs PP                      │   dsm-hero (blue→purple gradient)
│ ₱4.8M of ₱5.2M target · 92%       │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓▓░░░ 92%          │
├───────────────────────────────────┤
│ 🏪 12        │ 🏃 3/4             │
│ Distributors │ Active TSRs today  │   dsm-kpi-grid (2×2, white cards)
│──────────────┼────────────────────│
│ 💳 ₱2.1M     │ 🎯 8               │
│ AR overdue   │ Conversions · MTD  │
├───────────────────────────────────┤
│ 🏢 My Distributors     View all →  │
│  FARMCO CORP      ₱1.2M           │   dsm-card + dsm-dist-row ×5
│  CA000213         AR overdue ₱480K │
│  …                                │
├───────────────────────────────────┤
│ 👥 My TSRs         Open Patrol →   │
│  ⬤ MA  Maria Santos   │ 5 today   │   dsm-card + dsm-tsr-row ×N
│      12 stores · 5 visits today    │   (messenger-style avatars,
│  ⬤ JP  Juan Pérez     │ idle       │    green dot = active today)
├───────────────────────────────────┤
│ 🎯 Coaching Moments                │
│  🔴 Needs attention                │   dsm-coach-item.urgent
│   Maria no visits today            │
│  🟢 Recognise                      │
│   Juan 6 visits today — strong     │   dsm-coach-item.positive
├───────────────────────────────────┤
│ 🚨 Critical Today                  │
│  💳 AR overdue                     │
│   SMART-CHOICE GROCERY · 64d …     │
│  📉 Negative margin (MTD)          │
│   ZAMBALES AGRI · GP -2.3%         │
└───────────────────────────────────┘

   [📊 Home] [💰 AR] [🏃 Patrol] [🏢 Clients] [≡ More]   ← fixed bottom nav
```

### Palette
- Canvas `#F0F2F5` (Messenger background)
- Cards `#FFF` with `border-radius: 16px`, shadow `0 2px 8px rgba(0,0,0,0.04)`
- Hero gradient: `#0084FF 0% → #5B4BE2 55% → #A855F7 100%` (Facebook-blue → indigo → purple)
- Success deltas: `#B3FF8C` (on gradient) / `#42B72A` (on light)
- Warning: `#FFC72C`, Error: `#E0245E`
- Active dot on TSR avatar: `#42B72A` with 2px white border (iOS presence style)
- DSM badge: `#0084FF → #A855F7` gradient chip top-right

### Typography
- Headings/body: `Inter 400-900` (loaded alongside Montserrat/Source Code Pro)
- Numbers tabular via `font-variant-numeric: tabular-nums`
- Currency via `fmtPhpShort()` (₱4.8M / ₱480K / ₱800)

### Responsive
- Default: 500 px max-width, mobile phone size
- ≥ 900 px desktop: 4-col KPI grid, 1100 px shell, bottom nav hidden, 2-col distributor/TSR cards (via existing card flex flow).

### Interactions
- `click` a distributor row → `openCust(code)` → pg-custdetail
- `click` 🏪 KPI or "View all" → `navTo('pg-customers')`
- `click` 💳 KPI → `navTo('pg-ar')`
- `click` Patrol nav button → `openPatrolApp()` (placeholder: opens https://vieforce-patrol.vercel.app — Mat can swap to a deep link)
- Bottom "More" tab → slide-up sheet with National Dashboard / Sales / Inventory / Speed / Intelligence / Itemized / Logout

---

## 5 · Role routing — `initApp(session)`

Inserted immediately after the EVP branch:
```
role=dsm + mobile  → pg-dsm-home              (hides sidebar/topbar/collapse-btn
                                                via body.role-dsm CSS scope;
                                                shows bottom nav; calls loadDsmHome)
role=dsm + desktop → pg-home + sidebar "📊 DSM Dashboard" link revealed
                                                (body.role-dsm still applied so the
                                                 4-col hero works when navigated to)
all other roles    → unchanged
```

The DSM sidebar link `#nav-dsm` is `display:none` by default and revealed only when the session's role is `dsm`, matching the EVP pattern exactly.

Auto-refresh (`setInterval(60000) { DC = {}; loadPage(PG); }`) already calls `loadPage`, which now has a `pg-dsm-home` case → `loadDsmHome()`. So DSMs get 60s-auto-refresh for free.

---

## 6 · Patrol Supabase coupling

The project (same `yolxcmeoovztuindrglk.supabase.co` the HQ `js/supabase.js` uses) already has:
- `users.manager_id uuid REFERENCES users(id)` — from Patrol's `sprint-a-hierarchy.sql`
- `stores.assigned_tsr uuid REFERENCES users(id)` — from Patrol's `sprint-a-phase3-farms-fields.sql`
- `visits(visited_at timestamptz, tsr_id uuid, store_id uuid)` — from Patrol's base schema

So the DSM endpoint works against the production Supabase instance **today**, no migration needed. If a project is spun up from scratch without those columns, the endpoint returns `patrol_available: false` with a clear `patrol_error` field and the UI renders a "schema not migrated" empty state instead of crashing.

**Required user-record shape for the DSM → TSR hierarchy to work:**
```
users row for the DSM:   role='dsm',    id = <UUID>
users row for each TSR:  role='tsr',    manager_id = <UUID above>,   is_active = true
```

If Mat wants to test live, set a few `users.manager_id = <a dsm.id>` and assign a few `stores.assigned_tsr = <tsr.id>` — the dashboard populates instantly.

---

## 7 · Deployment

| Step | Artifact | Result |
|---|---|---|
| 1 | `git commit 415623c` → push origin | ✓ |
| 2 | `gcloud run deploy --source . --no-traffic --tag preview` | ✓ rev **`00063-zit`** |
| 3 | Preview smoke — `/api/dsm/home` with Rico session | ✓ HTTP 200 · shape complete · patrol_available=true · SAP-matched=0 (expected for TSR-role test user) |
| 4 | Preview smoke — all 10 existing endpoints HTTP 200 | ✓ dashboard/sales/ar/inventory/speed/customers/margin/intelligence/team/silenced |
| 5 | `gcloud run update-traffic --to-revisions 00063-zit=100` | ✓ 100% prod on `00063-zit` |
| 6 | `vercel --prod --yes` + alias | ✓ https://vieforce-hq.vercel.app now points to the DSM-enabled deploy |
| 7 | Static asset check | ✓ `/css/dsm-home.css` HTTP 200 · `/js/dsm-home.js` HTTP 200 · app.html has 23 DSM references |

### Rollback
```bash
gcloud run services update-traffic vieforce-hq-api \
  --region asia-southeast1 \
  --to-revisions vieforce-hq-api-00061-bek=100 --quiet
```
(`00061-bek` = silence-system revision, last known-good before DSM mobile.) Then revert `app.html` + remove `css/dsm-home.css` + `js/dsm-home.js` locally and redeploy Vercel.

---

## 8 · Manual verification

For DSM login you need a Supabase user with `role='dsm'` and at least one OINV row carrying their SlpName as the salesperson (or a SlpCode that maps to OSLP.SlpName ≈ their user.name).

1. Log in as a real DSM on a phone (or mobile-resize Chrome to 390 × 844 px).
2. Land on `pg-dsm-home` automatically. Sidebar + topbar hidden. Gradient hero visible.
3. Header shows **DSM name** · *District* · *N TSRs* · *M distributors*.
4. Hero shows **MTD revenue** + up/down delta vs prior period + % of target + progress bar.
5. 2×2 KPIs populated: distributors / active TSRs / AR overdue / conversions.
6. My Distributors card lists up to 5 with MTD revenue, volume, and AR-overdue subtext (red if any overdue).
7. My TSRs card shows Messenger-style rows — avatar initials, green presence dot if TSR has ≥1 visit today, inline "N today" action pill. Row count matches `/api/dsm/home tsrs[]`.
8. Coaching Moments populated if any urgent/positive/push events exist (otherwise shows graceful empty state).
9. Critical Today lists AR-overdue + negative-margin + idle-TSR sections.
10. Bottom tab bar: Home (active) · AR · Patrol · Clients · More.
11. Tap **More** → slide-up sheet with 7 items + Logout.
12. Tap **Patrol** → opens https://vieforce-patrol.vercel.app in new tab.
13. On desktop browser: DSM sees the existing National Dashboard with the new "📊 DSM Dashboard" sidebar link. Clicking it navigates to pg-dsm-home in a 4-col layout.

---

## 9 · v1.1 follow-ups

| # | Item | Why | Effort |
|---|---|---|---|
| 1 | **Conversion events** — a Patrol `conversions` table / field so `conversions_mtd` stops reading 0 | Coaching is blind to the most important DSM KPI | 2 h + Patrol schema |
| 2 | **Store-health scoring** for `critical.at_risk_stores` — based on visit recency + sell-through | Complete the "Critical Today" picture | 2 h |
| 3 | **Deep-link to Patrol app** — replace web placeholder with `viepatrol://` + APK detection fallback | Seamless one-tap switch for field managers | 1 h |
| 4 | **Target upload UI** — today the target = prev-period × 1.1 auto-stretch. Let HQ admins paste district monthly budgets | Hero % reflects real commitments, not a heuristic | 3 h |
| 5 | **SlpName sharpening** — the current `LIKE '%name%'` can over-match ("LUZON DISTRIBUTION" contains "DISTRIBUTION"). Use an explicit `dsm_slp_map.json` or OCRD UDF for exact mapping | Accuracy when two DSMs share a token | 1 h + Mat mapping |
| 6 | **TSR tap → TSR detail page** (per-TSR visits log, scorecard, SoV, last-seen store) | Natural drill-down; brief said "conversation-style row" implying a chat-like detail | 6 h |
| 7 | **Coaching heuristics v2** — tie to week-trailing visit cadence + store coverage (not just today) | Today-only view over-reacts to single off-days | 3 h |
| 8 | **Pull-to-refresh + skeleton shimmer on mobile** | Matches Messenger feel on the data-load path | 2 h |
| 9 | **Filter chips** — "This week / This month / YTD" on the hero | DSMs compare cadence, not absolute | 2 h |
| 10 | **DSM desktop layout** — currently still the mobile shell. A native 2-col view with the Distributor table expanded would help office use | Parity with EVP's desktop upgrade | 4 h |

---

## 10 · URLs + references

| | |
|---|---|
| Production frontend | **https://vieforce-hq.vercel.app** |
| Production API      | https://vieforce-hq-api-qca5cbpcqq-as.a.run.app (100% → `vieforce-hq-api-00063-zit`) |
| Preview API (same rev) | https://preview---vieforce-hq-api-qca5cbpcqq-as.a.run.app |
| GitHub branch       | `design-upgrade` @ `415623c` |
| Scout reference     | `docs/HQ_ARCHITECTURE_SCOUT.md` |
| Patrol schema       | `../vieforce-patrol/supabase/schema.sql` + `supabase/migrations/sprint-a-hierarchy.sql` |

---

*Generated 2026-04-18 · VieForce HQ · Vienovo Philippines Inc.*
