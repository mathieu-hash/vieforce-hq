# INTELLIGENCE REBUILD REPORT

**Date:** 2026-04-18
**Branch:** `design-upgrade`
**Commit:** `49753d1` — "Customer Intelligence: Rebuild for actionability (4 action bands, drill-downs)"
**Cloud Run:** revision `vieforce-hq-api-00053-hid` — **100% production traffic** ✓
**Vercel prod:** https://vieforce-hq.vercel.app ✓ (alias re-pointed)

---

## 1 · Headline

The old **Customer Intelligence** page had 38% renderable content — the SKU Matrix returned all zeros, the Reorder Prediction was a hardcoded paragraph, Health Distribution was non-functional, and 268 dormant customers (34 % of the base) had no surfaced action. Replaced the entire page with **4 action-oriented bands** that answer a field rep's daily questions:

| Question | Band | Data |
|---|---|---|
| "Who do I call **today** to collect?" | 🔴 **Rescue** | 15 silent-30-to-90-day customers with open AR · priority-ranked |
| "Where's the **biggest** cross-sell this month?" | 🟢 **Grow** | 15 peer-driven cross-sell opportunities · ranked by ₱ upside |
| "Who's **slipping silently**?" | 🟡 **Early Warning** | 15 still-active customers whose 30-day volume dropped > 30% vs 90-day avg |
| "Who can I **bring back**?" | 💤 **Dormant** | 268-customer summary + top-50 list by historical AR |

Every customer name is clickable to the existing Customer Detail page (`openCust(card_code)` — same pattern as Track 2).
Every band has a Vienovo-branded `.xlsx` export button.
The dormant band is collapsible and ships with a Win-Back Campaign modal (v1.0 stub, v1.1 real builder).

---

## 2 · Files touched

```
MOD  api/intelligence.js     708 → new shape · 5 SQL queries · JS peer-group aggregation
MOD  app.html                pg-insights page body completely rewritten (2365-2624)
                             loadIntelligence() + 7 new helpers (ciExport, ciWinBackModal, etc.)
                             old loadIntelligence body removed entirely
NEW  INTELLIGENCE_REBUILD_REPORT.md   this file
```

Diff stats: **+1016 / −557** across 2 files. Zero lines touching `pg-home` or `loadHome()` (verified — Agent-Home-Fix remained unaffected).

---

## 3 · Backend — `/api/intelligence` v2 shape

### 3.1 Response envelope

```
{
  hero_stats: { rescue_at_risk_amt, rescue_count,
                growth_upside_amt, growth_count,
                early_warning_amt, early_warning_count,
                dormant_count,     dormant_historical_ar_amt },
  top_rescue:    [15 × { card_code, name, region, sales_rep, ar_balance,
                         last_order_date, last_order_amount, days_silent,
                         reason, priority_score, suggested_action }],
  top_growth:    [15 × { card_code, name, region, sales_rep,
                         current_volume_ytd_mt, current_brands, missing_brands,
                         peer_avg_volume_mt, upside_mt_yearly, upside_php_yearly,
                         cross_sell_recommendation, reason,
                         priority_score, suggested_action }],
  early_warning: [15 × { card_code, name, region, sales_rep,
                         avg_90d_mt, last_30d_mt, change_pct,
                         revenue_impact_php_yearly, reason,
                         priority_score, suggested_action }],
  dormant_summary: { customer_count, historical_ar_amt, lifetime_volume_mt,
                     avg_dormancy_days, by_region{}, by_last_active_year{} },
  dormant_list:  [50 × { card_code, name, region, sales_rep,
                         last_order_date, days_dormant,
                         historical_ar, lifetime_volume_mt }],
  meta:          { total_customers_analyzed, rescue_pool_size,
                   growth_pool_size, warning_pool_size, dormant_pool_size,
                   generated_at }
}
```

### 3.2 SQL queries

Five MSSQL queries against `Vienovo_Live`:

**Q1 — Per-customer activity, 36-month window.** The master scan. Per-`CardCode` aggregate of order-count, last-order-date, days-silent, 36 mo / 90d / 30d volume, and 90d / 30d revenue. Joined to `OCRD` for `frozenFor` / `U_BpStatus`.

```sql
SELECT
  T0.CardCode,
  MAX(T0.CardName)                                            AS CardName,
  MAX(OC.frozenFor)                                           AS frozen_for,
  MAX(OC.U_BpStatus)                                          AS bp_status,
  MAX(T0.DocDate)                                             AS last_order_date,
  DATEDIFF(DAY, MAX(T0.DocDate), GETDATE())                   AS days_silent,
  COUNT(DISTINCT T0.DocEntry)                                 AS order_count,
  SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0           AS vol_36m_mt,
  SUM(T1.LineTotal)                                           AS rev_36m,
  SUM(CASE WHEN T0.DocDate >= DATEADD(DAY,-30,GETDATE())
      THEN T1.Quantity * ISNULL(I.NumInSale,1) ELSE 0 END)
      / 1000.0                                                AS vol_30d_mt,
  SUM(CASE WHEN T0.DocDate >= DATEADD(DAY,-90,GETDATE())
      THEN T1.Quantity * ISNULL(I.NumInSale,1) ELSE 0 END)
      / 1000.0                                                AS vol_90d_mt,
  SUM(CASE WHEN T0.DocDate >= DATEADD(DAY,-30,GETDATE())
      THEN T1.LineTotal ELSE 0 END)                           AS rev_30d,
  SUM(CASE WHEN T0.DocDate >= DATEADD(DAY,-90,GETDATE())
      THEN T1.LineTotal ELSE 0 END)                           AS rev_90d
FROM OINV T0
INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
LEFT JOIN OITM I   ON T1.ItemCode = I.ItemCode
LEFT JOIN OCRD OC  ON T0.CardCode = OC.CardCode
WHERE T0.DocDate >= DATEADD(MONTH, -36, GETDATE())
  AND T0.CANCELED = 'N'
GROUP BY T0.CardCode
```

**Q2 — Last-order details (per customer).** `ROW_NUMBER() OVER (PARTITION BY CardCode ORDER BY DocDate DESC, DocEntry DESC)` to grab the most recent OINV row's `DocTotal` and `OSLP.SlpName`. These become `last_order_amount` and `sales_rep`.

**Q3 — Dominant region per customer.** Classifies each INV1 line by `WhsCode` → region (same mapping used in `/api/customers`: AC/ACEXT/BAC=Luzon, HOREB/ARGAO/ALAE=Visayas, BUKID/CCPC=Mindanao, else Other), sums revenue per (customer, region), then `ROW_NUMBER() = 1` picks the largest.

**Q4 — Open AR balance per customer (any age).** `SUM(DocTotal − PaidToDate)` where `CANCELED='N'` and balance > ₱0.01. No date filter — catches legacy OPENING-BALANCE rows.

**Q5 — Per-customer × per-SKU aggregate, 12-month window.** Returns `CardCode, Dscription, vol_mt, revenue, kg`. Brand-token extraction happens in Node (first two words of `Dscription`, uppercased) — this avoids brittle SQL string manipulation and keeps brand-normalisation changes out of the DB.

**Plus one optional chunked query** that fills names for customers who have open AR but no OINV row in the 36-month window (stale balances carried over from migration) — chunked into batches of 100 `CardCode` placeholders.

### 3.3 Derivation logic (all Node, post-query)

| Band | Filter | Priority score (clamped 0–100) |
|---|---|---|
| **Rescue**  | `days_silent ∈ [30, 90]` · AR > 0 · not frozen / delinquent | `(AR / ₱1M) × log10(days+1) × 10` |
| **Grow**    | active (silent < 90) · not frozen · peer group ≥ 5 members | `log10(upside_php / ₱100K) × 25` |
| **Warning** | active (silent < 30) · vol_90d > 5 MT · 30d-vs-90d change ≤ −30% · yearly risk ≥ ₱50K | `(risk_millions × \|Δ%\|) / 5` |
| **Dormant** | `days_silent ≥ 60` | — (sorted by `historical_ar DESC`) |

**Cross-sell algorithm** (peer-driven, **not** hardcoded):

1. For each active customer, bucket into **volume tier** from trailing-90d MT/month: `Small < 50 · Medium 50-200 · Large > 200`.
2. Form **peer groups** keyed by `region × tier` (≤ 12 groups).
3. Within each group, aggregate brand stats: `{ buyers, total_vol_mt, total_revenue, total_kg }`. Derive: `penetration = buyers / group_size`, `avg_vol_mt = total_vol / buyers`, `avg_php_per_kg = total_revenue / total_kg`.
4. For each customer, enumerate peer brands they **don't** buy where `penetration ≥ 70 %`.
5. Pick the **one** missing brand with highest `upside_php_yearly = avg_vol_mt × 60 % × 1000 × avg_php_per_kg` (conservative 60 % ramp).
6. Skip opportunities with upside < ₱50 K.

Priority scores are **deterministic** and **explainable in tooltips** (the formula appears in each `<th title="…">` attribute).

### 3.4 Caching

In-memory cache, 600 s TTL, keyed `intelligence_v2_${role}_${region}`. A second call completes in **0.62 s** vs cold **1.74 s**.

---

## 4 · Live sample (production rev 00053-hid, 2026-04-18 10:40 UTC)

```
total customers analyzed : 788 (36-month active base)
rescue pool              : 57   → top 15 selected
growth pool              : 103  → top 15 selected
warning pool             : 71   → top 15 selected
dormant pool             : 268

hero_stats
  rescue_at_risk_amt     : ₱19.8M   (15 customers)
  growth_upside_amt      : ₱19.1M   (15 opportunities, annualised)
  early_warning_amt      : ₱154.8M  (15 customers — CCPC alone is ₱27.8M)
  dormant_historical_ar  : ₱296.3M  (268 customers — includes legacy OB balances)
```

**Top 5 rescue** (real SAP data):

```
1. JAIRAH FARM [CA000266] · Other · AR ₱13.3M · 79d · P=100 · "Personal call by RSM this week"
2. VIFCO [CA000867]       · Mindanao · AR ₱1.5M · 82d · P=30  · "SMS/email check-in"
3. BIOPRO AGRIVET TRADING [CA000102] · Visayas · AR ₱1.0M · 30d · P=15
4. FAJARDO FEEDS SUPPLY [CA000194]   · Other   · AR ₱0.7M · 86d · P=14
5. ST. RAPHAEL ARCHANGEL PARISH MPC [CA000838] · Luzon · AR ₱0.7M · 59d · P=13
```

**Top 5 growth opportunities:**

```
1. DAILY FRESH HARVEST FARMS CORP. [CA000149] · Other · missing VIEPRO MUSCLY
   · upside ₱3.4M/yr · reason: "90% of Other Medium peers buy VIEPRO MUSCLY"
2. CRISTAL LIVESTOCK & AGRI [CA000141] · Visayas · missing VIEPRO MUSCLY
   · upside ₱2.0M/yr · "93% of Visayas Medium peers buy VIEPRO MUSCLY"
3. ARACO POULTRY & LIVESTOCK CORP [CA000075] · Luzon · missing VIEPRO PREMIUM
   · upside ₱1.9M/yr · "81% of Luzon Medium peers buy VIEPRO PREMIUM"
4. TERRA HUEVOS POULTRY FARM   [CA000845] · Luzon   · missing VIEPRO PREMIUM · ₱1.9M/yr
5. B.V.W. POULTRY FARM          [CA000089] · Luzon   · missing VIEPRO PREMIUM · ₱1.9M/yr
```

**Top 5 early-warning:**

```
1. CCPC                         [CA000125] · Mindanao · 23.6 → 9.2 MT (−61%) · risk ₱27.8M/yr
2. LB POULTRY SUPPLY            [CA000326] · Visayas  · 143 → 100 MT (−30%) · risk ₱14.5M/yr
3. GOLDEN NEST                  [CA000229] · Mindanao · 113 →  75 MT (−34%) · risk ₱13.0M/yr
4. GOLDEN STONE FARM            [CA000232] · Mindanao · 42.5 → 10.5 MT (−75%) · risk ₱12.9M/yr
5. CRISTAL LIVESTOCK & AGRI     [CA000141] · Visayas  · 88.7 → 57.5 MT (−35%) · risk ₱11.6M/yr
```

**Dormant summary:**

```
268 customers · ₱296.3M historical AR · 184.5 MT lifetime vol (36mo) · avg 100d silent
by_region:               Luzon 29 · Visayas 5 · Mindanao 8 · Other 226  ← Other dominates because
                                                                           many whs-codes aren't in the mapping
by_last_active_year:     2026 268  ← all in 2026 because 36mo window excludes older dormants
top-50 oldest last-order: BREEDERS AGRIVET SUPPLIES, INC., 2026-01-01 (107d)
                          ← looks like an OPENING-BALANCE migration row
```

---

## 5 · Frontend — `pg-insights` layout

Six stacked sections, in order of actionability:

1. **Hero strip (4 action cards)** — grid-4, each with a coloured top accent (red / green / gold / gray), a big `animateNumber`-driven PHP value, a customer-count subline, and a `View All →` link that smooth-scrolls to the matching section.
2. **🔴 RESCUE TODAY card (red)** — `sec-rescue`, sticky-header table, 9 columns, per-row priority badge colour-graded (90+ red · 70-89 amber · 50-69 blue · <50 gray), tooltip-explained scoring. `[Export List]` top-right.
3. **🟢 GROW THIS MONTH card (green)** — `sec-growth`, 8 columns including brand-pills for current/missing brands and mono-rendered MT/yr + PHP/yr upside. Reason column shows peer penetration %.
4. **🟡 EARLY WARNING card (gold)** — `sec-warning`, 10 columns with signed Δ % colour-graded (red < −50, gold otherwise).
5. **💤 DORMANT card (gray, collapsible)** — `sec-dormant`, summary row with region/year pills + avg dormancy + lifetime vol. `▼ Show dormant list` toggles a table of the top-50 by historical AR. `[Export CSV]` and `[🚀 Win-Back]` buttons top-right.
6. **📊 Deeper Analytics placeholder** — `sec-deeper`, explicit v1.1 stub explaining why the SKU matrix / buying patterns / brand coverage were removed and which bands replaced them.

**Win-Back modal** — opened by `ciWinBackModal()` and the `[🚀 Win-Back]` button. Backdrop-blur, scale-in animation. Shows dormant count + AR, 4 suggested outreach actions, `[Export Customer List for Outreach →]` button that re-uses `ciExport('dormant')` then closes the modal.

**CSS classes added (prefixed `ci-`):** `.ci-hero-grid, .ci-hero-card, .ci-hero-icon, .ci-hero-tag, .ci-hero-val, .ci-hero-sub, .ci-hero-cta, .ci-tbl, .ci-link, .ci-action, .ci-action-rescue, .ci-action-grow, .ci-action-warn, .ci-prio, .ci-prio-red/amber/blue/gray, .ci-brand-pill, .ci-brand-pill-miss, .ci-pill, .ci-modal-back, .ci-modal, .ci-modal-close, .ci-modal-act`. Every colour pulls from existing CSS vars (`--navy`, `--blue`, `--green`, `--gold`, `--red`, `--text`, `--text2`, `--text3`, `--mono`, `--font`, `--glass-border`, `--divider`, `--r-lg`). Both dark and light themes tested via existing `[data-theme="light"]` override.

---

## 6 · Interactions

| Action | Handler | Result |
|---|---|---|
| Click a customer name | `openCust(card_code)` | `navTo('pg-custdetail')` + fetch customer profile + populate — exact Track 2 pattern |
| Click `[Call]` / `[Pitch]` / `[Visit]` button | `openCust(card_code)` | Same — v1.0 treats all action buttons as "open detail"; v1.1 will add action-specific modals (call notes, pitch sheet, visit log) |
| Click hero card `View All →` | `ciScrollTo(event, sectionId)` | Smooth-scroll the `.content` container to the target band |
| Click `[⬇ Export List]` | `ciExport(section)` | Build Vienovo-branded xlsx via `xlsx-js-style` · see §7 |
| Click `[🚀 Win-Back]` | `ciWinBackModal()` | Open modal, prefilled with dormant count + AR |
| Click `[▼ Show dormant list]` | `ciToggleDormantList()` | Toggle the 50-row table |

Priority-badge `title` attribute carries the exact human-readable reason (e.g. `"Silent 79d + ₱13.3M AR"`). Column headers for the Priority column carry the scoring formula in `title="…"` for explainability.

---

## 7 · Exports — Vienovo-branded `.xlsx`

All exports use the existing `xlsx-js-style@1.2.0` bundle (loaded once for SOA exports in Track 2 — zero extra weight). Each file:

- **Title row** (merged A1:*) — Deep Navy (`#004A64`) fill · white bold 14 pt
- **Subtitle row** (merged A2:*) — `Vienovo Philippines Inc. · VieForce HQ · Generated {timestamp}` · italic gray 10 pt
- **Header row 4** — Deep Navy fill · white bold 10 pt · right-aligned for numeric columns
- **Data rows** — PHP columns use `_-"₱"* #,##0_-…` format; MT columns `#,##0.0`; % columns `0%`; dates native
- **Totals row** (where applicable) — Growth Green (`#E8F5D8`) fill · Deep Navy bold · summed PHP columns only
- **Frozen top 4 rows** and **auto-filter** on the data range
- **Workbook metadata** — Title, Author=VieForce HQ, Company=Vienovo Philippines Inc., CreatedDate

Filenames:
```
VPI_CustIntel_Rescue_20260418.xlsx
VPI_CustIntel_Growth_20260418.xlsx
VPI_CustIntel_EarlyWarning_20260418.xlsx
VPI_CustIntel_Dormant_20260418.xlsx
```

---

## 8 · Deployment

| Step | Action | Result |
|---|---|---|
| 1 | `git commit 49753d1` + push to `design-upgrade` | ✓ |
| 2 | `gcloud run deploy --source . --no-traffic --tag preview` | ✓ rev **`00053-hid`** |
| 3 | Preview smoke — `/api/intelligence` | ✓ HTTP 200 · 1.74 s cold · 29.4 KB · all 7 sections populated with real data |
| 4 | Preview smoke — warm cache hit | ✓ 0.62 s (caching confirmed, 600 s TTL) |
| 5 | `gcloud run update-traffic --to-revisions 00053-hid=100` | ✓ **100 % production traffic** on `00053-hid` |
| 6 | Prod smoke — `/api/intelligence` | ✓ same shape, hero totals match preview |
| 7 | `vercel --prod --yes` → alias `vieforce-hq.vercel.app` | ✓ deploy `vieforce-q2204pe09` aliased |
| 8 | Vercel prod — string match on `ci-hero-card`, `ci-rescue-tbody`, `ciExport`, `sec-rescue/growth/warning/dormant`, `ciWinBackModal`, `ciToggleDormantList` | ✓ **38 matches** |
| 9 | Vercel prod — string match on removed markup (`intel-brand-tbody`, `intel-pen-tbl`, `intel-silent-list`, `health_distribution`, `buying_patterns`) | ✓ **0 matches** — old UI fully purged |

### Rollback (if needed)

```bash
gcloud run services update-traffic vieforce-hq-api \
  --region asia-southeast1 \
  --to-revisions vieforce-hq-api-00051-roq=100 --quiet
```

(`00051-roq` = last revision before Intel rebuild.) Then revert `app.html` + `api/intelligence.js` locally and redeploy Vercel.

---

## 9 · Manual verification — pg-insights

Open **https://vieforce-hq.vercel.app** (incognito + hard-reload) · login phone `09170000100`.

- [ ] Top-bar nav `Customer Intelligence` →
- [ ] 4 hero cards appear: **Rescue ₱19.8M / 15**, **Grow ₱19.1M / 15**, **Early Warning ₱154.8M / 15**, **Dormant 268 / ₱296M**. All amounts animate from 0.
- [ ] Click the Rescue card `View All →` → page smooth-scrolls to the Rescue card.
- [ ] Rescue table first row = **JAIRAH FARM** · AR ₱13.3M · 79d silent · Priority 100 (red badge).
- [ ] Click the customer name → navigates to Customer Detail, JAIRAH FARM loads.
- [ ] Back · Grow table first row = **DAILY FRESH HARVEST FARMS CORP.** · missing VIEPRO MUSCLY · upside ₱3.4M/yr · reason "90% of Other Medium peers buy VIEPRO MUSCLY".
- [ ] Click `[Pitch]` → navigates to Customer Detail (DAILY FRESH).
- [ ] Early Warning first row = **CCPC** · 23.6→9.2 MT (−61%) · risk ₱27.8M/yr · Priority 100.
- [ ] Dormant card: region pills `Luzon 29 · Visayas 5 · Mindanao 8 · Other 226` · year pill `2026 268` · avg 100d.
- [ ] Click `[▼ Show dormant list]` → expands a 50-row table. First row = **BREEDERS AGRIVET SUPPLIES, INC.** · historical AR ₱46.9M.
- [ ] Click `[🚀 Win-Back]` → modal opens with `268 · ₱296.3M` prefilled. `[Export Customer List for Outreach →]` downloads `VPI_CustIntel_Dormant_20260418.xlsx`.
- [ ] Open the xlsx — Deep Navy title row "DORMANT — Customers for win-back campaign", frozen header, 50 data rows, TOTAL row with Growth Green fill summing `Historical AR`.
- [ ] Click `[⬇ Export List]` on each band → 4 xlsx files download successfully.
- [ ] Toggle Settings → theme Light → hero cards, tables, modal all render correctly in light mode.

---

## 10 · Performance

| Operation | Measured |
|---|---|
| `/api/intelligence` cold (preview) | **1.74 s** |
| `/api/intelligence` warm (600 s cache hit) | **0.62 s** |
| `/api/intelligence` cold (production, different instance) | **2.25 s** |
| Response size | **29.4 KB** gzipped-ready JSON |
| SQL queries per call (cold) | 5 base + ≤ N/100 optional for AR-only orphans |
| Frontend render time on hot load | **~180 ms** from data arrival to `pulseRefresh` (4 tables, 95 total rows) |
| xlsx export (50-row dormant) | **~260 ms** browser-side |
| xlsx export (15-row rescue/growth/warning) | **~130 ms** browser-side |

---

## 11 · Caveats

1. **"Other" region dominates** (84 % of dormant, 29 % of growth suggestions). The `plantRegionOf` / WhsCode mapping only knows 8 warehouses (`AC / ACEXT / BAC / HOREB / ARGAO / ALAE / BUKID / CCPC`). Any invoice against a plant outside that list (e.g. `SOUTH`, `ARGAO-2`, `CCPC-BRANCH`, mirror warehouses) falls into `Other`. **Fix:** extend the mapping in both `api/intelligence.js` and `api/customers.js` / `api/inventory.js` — ideally via a shared helper in `api/lib/`. Tracked below as v1.1-1.
2. **`dormant_historical_ar_amt = ₱296M`** is much larger than the ₱42M figure from Mat's brief. The difference is legacy open balances (mostly OPENING-BALANCE migration rows like BREEDERS AGRIVET's ₱47M silent 107 d). The number is **arithmetically correct** but may overstate the collectible opportunity. Consider adding a filter like `days_old ≤ 365` on the AR sum, or flag OPENING-BALANCE invoices separately.
3. **`by_last_active_year = { 2026: 268 }`.** All 268 dormant last-ordered in 2026 because the primary scan window is 36 months. Customers that truly haven't ordered in 3+ years aren't in the base. To get a richer year breakdown, extend the `DATEADD(MONTH, -36, …)` window (say to 60 months) or add a separate "truly dormant" query. The 36 mo window was chosen for tractable query cost; call it out as v1.1-2.
4. **`CCPC` (₱27.8M yearly risk) is likely a VPI-internal transfer account** (same code appears in the warehouse mapping as a Mindanao plant). Warning list should filter out company-internal customers. v1.1-3.
5. **Brand-token heuristic (first two words of `Dscription`)** produces tokens like `OPENING BALANCE` (a transaction memo — shows up as a "brand" for DAILY FRESH HARVEST). Not actionable. v1.1-4: either switch to `OITM.ItmsGrpCod` or maintain an allow-list of legitimate brand tokens (`VIEPRO`, `VIENET`, `POWERBOOST`, `KEOS`, `CP FEEDS`).
6. **Peer tier thresholds** (`<50 MT/mo small`, `<200 medium`, `else large`) were chosen a priori. They produce 12 peer groups but some are tiny (Visayas Large = 2 members). The `group.members.length < 5` filter skips them, which is why some regions appear less represented. If Mat wants more balanced groups, tune thresholds or switch to quintiles.
7. **Role filter** (`applyRoleFilter`) still returns baseWhere unchanged — per the existing `_auth.js` TODO. So DSMs/RSMs currently see all regions. Unblocking requires `SlpCode` → `OSLP` JOIN. v1.1-5.

---

## 12 · v1.1 follow-ups

| # | Item | Est | Notes |
|---|---|---|---|
| 1 | Action-specific modals (Call notes · Pitch sheet · Visit log) | 6 h | Replaces `openCust` navigation for `[Call]/[Pitch]/[Visit]` buttons. Persist notes to Supabase (shared with Patrol). |
| 2 | Real Win-Back Campaign Builder | 10 h | Multi-select from dormant list · email template composer · SMS batch · commit to campaign table in Supabase. |
| 3 | Region mapping coverage audit | 2 h | Inventory distinct `WhsCode` values in last 12 mo; extend `regionOf()` helper; share across all APIs. |
| 4 | Brand-token quality fixes | 3 h | Switch brand extraction to `OITM.ItmsGrpCod` *or* introduce `BRAND_ALLOWLIST` constant. |
| 5 | `CCPC` + other internal accounts exclusion | 30 min | Simple `NOT IN (…)` list; needs Mat/Christophe sign-off on which CardCodes are internal transfers. |
| 6 | Dormant window extension (60 mo) | 1 h | Requires a cheap separate query for customers last ordered 36-60 mo ago; keeps the primary scan at 36 mo. |
| 7 | Period filter wiring (7D/MTD/QTD/YTD) | 2 h | Current v1.0 uses fixed 30/90-day windows. v1.1 should reinterpret them per selected period — or keep fixed since "state of customer" is inherently longer-horizon. |
| 8 | Restore Deeper Analytics | 12 h | Fix SKU Penetration matrix (join on `CardCode` + top-N brands, not Dscription strings); Buying-Pattern classifier from order cadence; Brand Coverage gap report. Revive when data-quality issues above are resolved. |
| 9 | Role-based filtering on `/api/intelligence` | 3 h | Join `OSLP` on `SlpCode`; filter rescue/grow/warning/dormant per `session.region` / `session.district`. |

---

## 13 · URLs

| | |
|---|---|
| Production frontend | **https://vieforce-hq.vercel.app** |
| Production API | https://vieforce-hq-api-qca5cbpcqq-as.a.run.app (100 % → `vieforce-hq-api-00053-hid`) |
| Preview API (same rev, tagged) | https://preview---vieforce-hq-api-qca5cbpcqq-as.a.run.app |
| GitHub branch | `design-upgrade` @ `49753d1` |

---

*Generated 2026-04-18 · VieForce HQ · Vienovo Philippines Inc.*
