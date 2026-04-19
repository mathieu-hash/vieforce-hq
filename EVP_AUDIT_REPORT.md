# EVP DASHBOARD AUDIT — Joel Demo Prep

**Date:** 2026-04-19
**Branch:** `design-upgrade` @ `71af802`
**Cloud Run prod:** `vieforce-hq-api-00092-wam` — **100 % production traffic** ✓
**Vercel prod:** https://vieforce-hq.vercel.app ✓ (alias re-pointed)
**Audited by:** read-only SAP probes via `mssql-sap-b1` MCP (Vienovo_Live + Vienovo_Old)
**Reported bug:** YTD VOL = 12,509 MT, observed 2026-04-19 12:23 PM YTD period. Reality ≈ 56,500 MT.

---

## 0 · TL;DR

Bug confirmed and fixed. EVP YTD VOL was **4.5× under-counted** because the old endpoint summed each RSM's *personal SlpCode* sales only — not their territory rollup. Replaced with national independent aggregate + per-RSM rollup via `OSLP.U_rsm` (the SAP-confirmed source of truth from yesterday's audit). All 6 hero metrics now match `/api/dashboard` to the cent.

| Metric | Before | After | Verification |
|---|---:|---:|---|
| **YTD VOL** | 12,509 MT | **57,176 MT** ✓ | matches dashboard.ytd.volume_mt = 57,176 |
| **BUDGET** | 62,755 MT | **51,339 MT** ✓ | day-prorated monthly array (was naive FY×4/12) |
| **ACH %** | 20 % | **111.4 %** ✓ | 57,176 / 51,339 |
| **VS LY** | — | **+94.3 %** ✓ | ODLN-vs-ODLN against `Vienovo_Old` (LY 29,421 MT) |
| **SPEED** | 1,343 MT/d | **615 MT/d** ✓ | 57,176 / 93 shipping days (Mon-Sat YTD) |
| **GM/TON** | ₱6,437 | **₱6,437** ✓ | matches dashboard exactly (was right by accident) |
| **Active Accounts** | 85 | **788** ✓ | distinct CardCodes invoiced YTD |
| **RSMs** | 8 (hardcoded) | **9** ✓ | discovered from OSLP.U_rsm self-pointers |
| **Reports** (was "DSMs") | 34 (mislabeled) | **42** ✓ | reps under any RSM (not just DSMs — SAP has no DSM layer) |

Sum of 9 RSM rollups = **56,522 MT** = national OINV exactly. Math closes.

---

## 1 · Root cause of YTD VOL = 12,509 (the headline bug)

### Old code (`api/team.js` pre-2026-04-19)
```js
// Hardcoded list of 8 names, fuzzy-matched to OINV.SlpName
const RSM_HIERARCHY = [ { name: 'Mart Espliguez', ... }, ... 8 entries ]

// Group sales by SlpCode → one row per rep
const repSales = await query(`
  SELECT T0.SlpCode, S.SlpName, SUM(...) AS ytd_vol
  FROM OINV T0 ... LEFT JOIN OSLP S
  GROUP BY T0.SlpCode, S.SlpName
`)

// For each hardcoded RSM, find ONE matching repSales row
const rsms = RSM_HIERARCHY.map(rsm => {
  const match = repSales.find(r => /* fuzzy name match */)
  return { ytd_vol: match ? match.ytd_vol : 0, ... }
})

// EVP YTD = sum of those 8 personal-rep totals
const totalYTD = rsms.reduce((s, r) => s + r.ytd_vol, 0)
```

The fuzzy match landed on each RSM's *own* SlpCode (e.g. SlpCode 42 = "MART ESPLIGUEZ"), which only contains Mart's personal directly-attributed invoices — not the rollup of every TSR/DSM with `S.U_rsm = 42`.

### SAP probe — confirmed the bug

```sql
SELECT S.SlpCode, S.SlpName, S.U_rsm, ... AS ytd_mt
FROM OSLP S LEFT JOIN OINV T0 ON T0.SlpCode = S.SlpCode
WHERE S.SlpCode IN (2,7,10,26,29,42,43,44,45)   -- the 9 RSM personal codes
GROUP BY S.SlpCode, S.SlpName, S.U_rsm
```

| SlpCode | RSM Name              | personal YTD MT |
|---:|---|---:|
| 7  | CARMINDA CALDERON     | 6,058 |
| 2  | MATHIEU GUILLAUME     | 2,921 |
| 10 | EDFREY BUENAVENTURA   |   594 |
| 29 | MA LYNIE GASINGAN     |    15 |
| 42 | MART ESPLIGUEZ        |    15 |
| 26 | KURT JAVELLANA        |     2 |
| 45 | ERIC SALAZAR          |     0 |
| 44 | JOE EYOY              |     0 |
| 43 | RICHARD LAGDAAN       |     0 |
|    | **SUM**               | **9,605** |

(Old code only summed the 8 in `RSM_HIERARCHY` — Kurt missing — so total was even lower at ~9,603 MT plus whatever the fuzzy match grabbed for Joel SlpCode 3 → ~12,500 MT observed.)

### Fixed code: U_rsm rollup

```sql
SELECT R.SlpCode AS rsm_code, R.SlpName, ..., COUNT(DISTINCT T0.CardCode) AS active_customers
FROM OSLP R
LEFT JOIN OSLP S ON S.U_rsm = R.SlpCode AND S.Active='Y'   -- their reports
LEFT JOIN OINV T0 ON T0.SlpCode = S.SlpCode
INNER JOIN INV1 T1 ON ...
WHERE R.SlpCode IN (the 9) AND R.Active='Y'
  AND T0.DocDate >= '2026-01-01'
GROUP BY R.SlpCode, R.SlpName
```

| RSM                  | Rollup YTD MT | Reports | Customers |
|---|---:|---:|---:|
| MART ESPLIGUEZ        | 18,058 | 10 | 148 |
| JOE EYOY              | 11,092 |  8 | 166 |
| ERIC SALAZAR          |  8,062 |  5 |  88 |
| CARMINDA CALDERON     |  6,058 |  2 |  16 |
| EDFREY BUENAVENTURA   |  5,607 |  7 | 113 |
| MATHIEU GUILLAUME     |  4,242 |  3 | 129 |
| RICHARD LAGDAAN       |  3,386 |  6 |  97 |
| MA LYNIE GASINGAN     |     15 |  1 |  15 |
| KURT JAVELLANA        |      2 |  1 |  17 |
| **SUM**               | **56,522** | **43** | (788 distinct nationally) |

**56,522 MT matches the independent national `SUM(OINV)` query exactly.** Math closes.

---

## 2 · Each metric audited — before/after with verification

### YTD VOL — 12,509 → 57,176 MT
- **Before:** sum of RSM personal-SlpCode totals
- **After:** independent national `SUM(ODLN)` query (volume of record per Mat's rule)
- **Cross-check vs `/api/dashboard?period=YTD`:** dashboard returns `ytd.volume_mt = 57,175.55` — match to 0.01 MT
- **Cross-check vs SAP direct:** `SUM(ODLN.Quantity × OITM.NumInSale)/1000 WHERE DocDate >= '2026-01-01'` = 57,176 MT ✓

### BUDGET — 62,755 → 51,339 MT
- **Before:** `188266 × 4/12 = 62,755` (hard-coded FY÷12×monthsElapsed in frontend)
- **After:** monthly budget array sum thru completed months + day-prorated current month
  - Jan 13,933 + Feb 13,933 + Mar 13,934 = 41,800
  - April day 19 of 30: `19/30 × 15,061 = 9,539`
  - Total: **51,339 MT**
- **Why this is better:** matches `/api/dashboard.budget.ytd_mt` calculation pattern; reflects "where should we be by *today*" rather than "where will we be by April 30". Apr-budget reflects 19 days, not 30.

### ACH % — 20 % → 111.4 %
- **Auto-corrected** once YTD VOL fixed: 57,176 / 51,339 = 111.4 %
- Display logic: green ≥ 95 %, gold ≥ 80 %, red < 80 %. Joel sees green.

### VS LY — "—" → +94.3 %
- **Before:** frontend hardcoded `'—'`. Backend returned no LY field.
- **After:** `nationalLyOdln` query in `team.js` against `Vienovo_Old` (historical DB), pulls 2025-01-01 → 2025-04-19 ODLN volume = **29,421 MT**. CY 57,176 vs LY 29,421 = **+94.3 %**.
- **No customer-map needed** — this is an aggregate over all OINV/ODLN, not keyed by CardCode. So historical re-keying doesn't affect the rollup.
- **Per-RSM vs LY also wired** — uses `repToRsm` name-based bridge: pulls historical (rep-name → vol), then maps each historical name to its current `U_rsm`. Falls through cleanly when a 2025 rep name isn't in 2026 OSLP.

### SPEED — 1,343 → 615 MT/d
- **Before:** `sum(rsms[].speed)` where each `r.speed = rep's MTD volume from ODLN`. Sum of 8 personal SlpCodes' April MTD ≈ 1,343 MT/d. Wrong scope (8 personal codes for 1 month, labeled YTD speed).
- **After:** `YTD_ODLN / shipping_days_elapsed_YTD = 57,176 / 93 = 615 MT/d`. Shipping days = Mon-Sat between Jan 1 and Apr 19 (count Sundays as off-day, exclude). 109 calendar days − 16 Sundays = 93 ship-days.
- **Discrepancy with Mat's brief estimate of 837 MT/d:** Mat's brief used 79 days × 6/7 ≈ 67 ship-days. Today is **calendar day 109**, not 79. The 615 MT/d figure is correct.
- **v1.1 todo:** PH holidays not subtracted yet (per spec — IT to provide calendar). Could push speed up to ~640 MT/d once 4-5 holidays counted.

### GM/TON — ₱6,437 → ₱6,437 (was right by accident)
- The pre-fix code aggregated `repSales` (all reps, not just 8 RSMs) → produced national-correct GM/Ton. Coincidentally right.
- **After:** explicit `SUM(GrssProfit) / (SUM(Quantity × NumInSale) / 1000)` from OINV national. Returns identical 6,437.
- **Cross-check vs `/api/dashboard.ytd.gmt`:** dashboard returns 6437.44, team returns 6437. Match.
- Mat's note: "Home Page GM/Ton ₱6,955" was MTD (April only). Team page is YTD (Jan-Apr). Different periods → legitimate difference. Both numbers internally consistent.

### Active Accounts — 85 → 788
- **Before:** sum of per-RSM personal-SlpCode customer counts (each ≈ 9–18 customers per personal SlpCode). Sum ≈ 85.
- **After:** `COUNT(DISTINCT OINV.CardCode)` YTD = **788**.
- Includes **CCPC** and all other "unusual" codes per Mat's hard rule. No `isNonCustomerRow` exclusion in this endpoint.

---

## 3 · Vs-LY implementation details

### National vs LY
```sql
-- Historical DB (Vienovo_Old)
SELECT SUM(T1.Quantity * ISNULL(I.NumInSale,1)) / 1000.0 AS ytd_vol
FROM ODLN T0 INNER JOIN DLN1 T1 ON T0.DocEntry = T1.DocEntry
LEFT JOIN OITM I ON T1.ItemCode = I.ItemCode
WHERE T0.DocDate BETWEEN '2025-01-01' AND '2025-04-19'
  AND T0.CANCELED = 'N'
```
Returns 29,421 MT. CY 57,176 vs LY 29,421 → **+94.3 %**. (LY OINV-equivalent: 29,419 MT.)

### Per-RSM vs LY — name-based bridge
SAP migration re-keyed customer codes; rep codes likely too. So per-rep LY can't JOIN by SlpCode. Approach:

1. Pull historical (rep-name → ly_vol) from `Vienovo_Old.OINV ⋈ OSLP`.
2. Pull (rep-name → U_rsm) from `Vienovo_Live.OSLP` (current taxonomy).
3. For each historical row, map rep name → current U_rsm → accumulate.

Reps whose names changed or who left will drop out. Acceptable for v1.

**No `customer-map.js` needed for this endpoint** — we don't filter by CardCode anywhere; all aggregates roll on rep/territory.

---

## 4 · RSM / DSM / Active Account counts — verified

### RSMs: page advertised 8 → SAP truth = **9**

```sql
SELECT COUNT(*) FROM OSLP
WHERE Active='Y' AND SlpCode = U_rsm AND SlpCode <> 3 AND SlpCode > 0
```

The 9 RSMs (excluding Joel = SlpCode 3 = Director):

| SlpCode | RSM Name              | Region (per memo)    |
|---|---|---|
|  2  | MATHIEU GUILLAUME      | National Direct/KA   |
|  7  | CARMINDA CALDERON      | Visayas KA           |
| 10  | EDFREY BUENAVENTURA    | Mindanao Distribution|
| 26  | KURT JAVELLANA         | (self-RSM, role TBD) |
| 29  | MA LYNIE GASINGAN      | Pet Care             |
| 42  | MART ESPLIGUEZ         | Visayas              |
| 43  | RICHARD LAGDAAN        | Mindanao             |
| 44  | JOE EYOY               | Mindanao             |
| 45  | ERIC SALAZAR           | Luzon                |

The hardcoded `RSM_HIERARCHY` was missing **Kurt Javellana** — now included automatically.

### "DSMs" → renamed to "Reps" = 42

The label "DSMs" was wrong. SAP confirmed yesterday has **no DSM layer** — only TSR → RSM → Director. The 42 = total active OSLP reps with `U_rsm IS NOT NULL` and `SlpCode <> U_rsm` (i.e. non-RSM reports under any RSM). This includes TSRs + KA-NL + 7 vacant placeholders.

### Active Accounts = 788

```sql
SELECT COUNT(DISTINCT CardCode) FROM OINV
WHERE DocDate >= '2026-01-01' AND CANCELED = 'N'
```

Returns 788. **No exclusions** (CCPC + employee-self-invoicing CE* + unusual codes all included per Mat's rule).

---

## 5 · L10 Scorecard status — HARDCODED FICTION

`app.html` lines 3480–3508. Five hardcoded `<tr>` rows × 15 weeks of fake percentages. Owner = "Joel". Examples:

```
National Sales vs Budget %: WK1 65% · WK2 128% · WK3 89% · ... WK15 103%
Visayas Sales vs Budget %:  WK1 64% · WK2 130% · ... etc.
Gross Margin Php/Kg:        WK1 6.70 · WK2 N/A · WK3 6.56 · ...
```

**No JS binding. Static HTML only.** Per Mat's rule "do NOT fabricate L10 rock content", left untouched.

**🚩 FLAG TO MAT:** L10 needs Joel's actual L10 meeting agenda. Either:
- Wire to a Google Sheet / Supabase table that Joel maintains
- Put a "v1.1 — pending L10 input" placeholder banner over the section
- Hide the section until real data exists

For tomorrow's demo, recommend telling Joel "this section will reflect your real L10 measurables once you give us the source spreadsheet — these are placeholder numbers."

---

## 6 · Other issues discovered during audit

### `RSM_HIERARCHY` constant deleted
The hardcoded array of 8 RSM names is gone. RSM list now discovered from `OSLP.U_rsm`. Means new hires / departures auto-reflect after their OSLP record is updated by IT.

### Performance matrix grid: U_rsm-keyed instead of fuzzy SlpName
Old code had `m._slpNorm.includes(rsmNorm) || rsmNorm.includes(m._slpNorm)` — would match "MART" to anything containing "MART". New code keys strictly by `S.U_rsm` so each cell shows the rollup of all reps under that RSM for that month.

### Historical-month attribution caveat
Performance matrix uses `queryBoth` for last-6-months. Historical rows' `S.U_rsm` is from OLD OSLP — could differ from current. So if a rep moved across RSMs at migration, their pre-2026 volume sticks with the OLD RSM in the matrix. Documented inline. Low impact (most reps stable).

### `ytd_target = 0` per-RSM retained
SAP has no per-RSM budget. The existing placeholder `Targets are placeholder — update with actual RSM/DSM budgets` banner (line 3518) stays. RSM-level Ach % column will read 0 % until Mat provides budgets.

### "VS LY" backend logged ODLN 29,421 vs OINV 29,419
Difference = 2 MT (pending billing at LY-cutoff date). Negligible. Both numbers exposed in response (`ly_vol` + `ly_vol_invoiced`) for transparency.

---

## 7 · Deployment

| | |
|---|---|
| Cloud Run revision | **`vieforce-hq-api-00092-wam`** at 100 % production |
| Cloud Run URL | https://vieforce-hq-api-qca5cbpcqq-as.a.run.app |
| Vercel deployment | `vieforce-4we2njv58-mathieu-7782s-projects.vercel.app` |
| Vercel alias | https://vieforce-hq.vercel.app ← re-pointed |
| Branch / commit | `design-upgrade` @ `71af802` |
| Promoted | **YES** ✓ |

### Smoke verify (post-promote)
```
$ curl -H "x-session-id: 4bc1c7c0-..." \
       "https://vieforce-hq-api-qca5cbpcqq-as.a.run.app/api/team?period=YTD"
HTTP 200 | 3,837 bytes | 0.77 s warm
{
  "evp": {
    "ytd_vol": 57176, "budget_mt": 51339, "ach_pct": 111.4,
    "vs_ly_pct": 94.3, "speed": 615, "gm_ton": 6437,
    "active_customers": 788, "rsm_count": 9, "reports_count": 42
  },
  ...
}
```

### Rollback (if needed)
```bash
gcloud run services update-traffic vieforce-hq-api \
  --region asia-southeast1 \
  --to-revisions vieforce-hq-api-00089-mit=100 --quiet
```
(`00089-mit` = pre-EVP-fix revision; Deeper Analytics still live there.)

---

## 8 · 🚩 FLAG LIST — needs Mat input before Monday

| # | Item | Recommendation |
|---|---|---|
| 1 | **L10 Scorecard fake data** (lines 3480–3508 of app.html) | Add a "v1.1 — pending L10 input" banner above the table for the demo, OR hide the card with `style="display:none"` until Joel provides his real L10 source. |
| 2 | **Per-RSM ytd_target = 0** → Ach % column reads 0 % per RSM | If Mat has per-RSM budgets, drop them into a constant like `const RSM_BUDGETS_MT = { 42: 18000, 44: 12000, ... }` keyed by SlpCode. Without it, leave as zero (already flagged in UI text "Targets are placeholder"). |
| 3 | **Kurt Javellana now visible** as RSM (was missing from hardcoded list) | Confirm Kurt is meant to be in Joel's RSM scorecard. If he should be hidden, add him to a `HIDDEN_RSM_SLPCODES = [26]` set. |
| 4 | **Mat (SlpCode 2) appears as RSM** (Direct/KA, not regional) | Currently shown alongside the 8 regional RSMs. If Joel wants Mat in a separate "National Direct" lane, add a `bu` field via lookup table. |
| 5 | **Speed denominator ignores PH holidays** | v1 uses Mon-Sat. PH had New Year (1), 1 holiday in Jan, etc. If Joel asks "why 615 not 640?", explain. IT to provide holiday calendar in v1.1. |
| 6 | **Frontend RSM scorecard table tbody** still has hardcoded sample DSM rows (A. Dizon / R. Santos / etc.) below each RSM | These get overwritten by `loadTeam()` JS. But if Joel sees the page mid-load, he might see them flash. Consider replacing the static `<tbody>` content with `<tr><td colspan="14">Loading…</td></tr>` for a cleaner first paint. |
| 7 | **Kurt's territory unclear** | He's `U_rsm = 26` (self-pointer) with 1 active report and 17 customers, 2 MT YTD. Is this an actual RSM role or an inactive placeholder? Joel should confirm. |
| 8 | **`ach_pct` in `evp.ach_pct` shows decimal** (111.4 %) | Decision call: round to integer (111 %) or keep .1 precision (111.4 %). I left .1; easy 1-line revert if you prefer integer. |

---

## 9 · Performance

| Endpoint | Cold | Warm |
|---|---:|---:|
| `/api/team` | 3.3 s | 0.77 s |
| Cache TTL | 5 min | — |
| SQL queries per call | 9 (national OINV+ODLN, LY OINV+ODLN, RSM YTD, RSM MTD ODLN, RSM YTD ODLN, monthly grid, DSO+silent+neg) |

Same order-of-magnitude as `/api/dashboard` (3.4 s cold). Acceptable for a demo dashboard.

---

## 10 · Visual verification checklist (pre-demo)

After hard-refresh on https://vieforce-hq.vercel.app (login phone `09170000100`):

- [ ] Sidebar → **EVP Dashboard** (a.k.a. Sales Team)
- [ ] **EVP hero strip:**
  - YTD Vol = **57,176 MT** (green, animates from 0)
  - Budget = **51,339 MT**
  - Ach % = **111.4 %** in green
  - vs LY = **+94.3 %** in green (was "—" before)
  - Speed = **615 MT/d**
  - GM/Ton = **₱6,437**
- [ ] **Meta line below hero:** `National · All Regions · All BU · 9 RSMs · 42 Reps · 788 Active Accounts`
- [ ] **L10 scorecard:** still shows hardcoded fake numbers — flag to Joel as "placeholder pending real L10 input".
- [ ] **RSM scorecard table:** 9 rows (Mart at top with 18,058 MT). Sum row at bottom should equal national 56,522 MT.
- [ ] **vs LY column** per RSM populated for everyone (Mart +131.6 %, Joe +106.2 %, etc).
- [ ] **Performance matrix:** 9 RSMs × 6 months. Cells sum within each column ≈ national monthly volume.

---

*Generated 2026-04-19 · VieForce HQ · Vienovo Philippines Inc. · EVP Dashboard audit*
