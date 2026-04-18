# TRACK 2 — Workflow Features

**Date:** 2026-04-18
**Branch:** `design-upgrade`
**Commit:** `7686bac` — "Track 2: SOA PDF+Excel, global customer search, Inventory drill-down"
**Cloud Run:** revision `vieforce-hq-api-00049-fof` — **100% production traffic** ✓
**Vercel prod:** https://vieforce-hq.vercel.app ✓

---

## Summary

| Feature | Status | Files | API | UI |
|---|---|---|---|---|
| 1A — SOA PDF        | ✅ Live | `api/customer-soa.js` + modal + jsPDF build | `GET /api/customer/soa` | `generateSOAPDF()` |
| 1B — SOA Excel      | ✅ Live | same endpoint + xlsx-js-style workbook | same | `generateSOAExcel()` |
| 1D — SOA modal      | ✅ Live | `app.html` `#soa-backdrop` | — | `openSOAModal()` on `Issue SOA` click |
| 2  — Global search  | ✅ Live | `api/search.js` + dropdown | `GET /api/search` | `gsOnInput/Keydown/...` |
| 3  — Inv drill-down | ✅ Live | `app.html` client-side filter | — | `applyInvFilter(type,val)` |

---

## 1 · Files created / modified

```
NEW  api/customer-soa.js            189 lines   SOA data: customer+last_pay+aged invoices+DSO
NEW  api/search.js                   86 lines   Customer global search: TOP 8 ranked
MOD  server.js                       +4 lines   mount /api/customer/soa + /api/search
MOD  js/api.js                       +2 lines   getCustomerSOA, searchGlobal wrappers
MOD  app.html                      +876 lines   modal HTML/CSS + dropdown + filter-bar +
                                                 all Track 2 JS block (jsPDF builder,
                                                 xlsx-js-style workbook, search, drill)
```

**Library CDN changes in `<head>`:**
```diff
- <script src="https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"></script>
+ <script src="https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js"></script>
+ <script src="https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js"></script>
+ <script src="https://cdn.jsdelivr.net/npm/jspdf-autotable@3.8.1/dist/jspdf.plugin.autotable.min.js"></script>
```

`xlsx-js-style` is a drop-in replacement for SheetJS with full cell styling support. Existing Quick Wins export buttons continue to work (same `XLSX` global, same `table_to_book`/`writeFile` API).

---

## 2 · FEATURE 1 — SOA Generation

### 2.1 Backend — `/api/customer/soa?id=CA000196`

Five-query orchestration (all parameterised):

1. **Customer info** — `OCRD` ⋈ `OSLP` (sales_rep) ⋈ `OCTG` (payment_terms). Also pulls `CreditLine` and `frozenFor` to derive `account_status` (Frozen vs Active).
2. **Last payment** — `ORCT` top-1 by `DocDate DESC` where `Canceled='N'`.
3. **Open invoices** — `OINV` where `(DocTotal - PaidToDate) > 0.01`, sorted ascending by `DocDueDate`. Returns `doc_date, doc_num, doc_type (from ObjType 13 / 203), po_ref (NumAtCard), doc_total, paid_to_date, balance, due_date, days_old`.
4. **Aging bucketing** — done in Node: `current, 1-30, 31-60, 61-90, 91-120, 121-365, over_1y` plus percentages vs total_ar.
5. **DSO** — 90-day trailing sales basis: `dso = total_ar / (sales_90d / 90)`.

**Status classification:**
| Days old | Status |
|---|---|
| ≤ 0 | Current |
| 1–30 | Watch |
| 31–60 | Overdue |
| 60+ | Critical |

**Cache:** 60s TTL (near-realtime, per Mat's brief).

**Live sample (production rev 00049, FALCOR MARKETING CORPORATION):**
```
customer:    FALCOR MARKETING CORPORATION  (CA000196)
total_ar:    ₱11,102,471.18        ← matches AR page (₱11.1M brief)
dso:         17 days
credit_used: 74%                    ← CreditLine ₱15M
last_pay:    2026-04-17  ₱4,046,761.43
aging:       current=₱6.77M · 1-30=₱4.34M · others=0
invoices:    33 open                ← matches brief
statuses:    Current:16, Watch:17   (all ≤30d old — strong payer)
```

### 2.2 PDF SOA

Built client-side via **jsPDF (UMD)** + **jspdf-autotable** — zero server-side rendering.

**Layout (A4 portrait, 210 × 297 mm):**

```
┌──────────────────────────────────────────────────┐  ← Deep Navy band (26mm)
│ [VPI] VIENOVO PHILIPPINES INC.   STATEMENT OF    │     #004A64
│       Animal Feed Manufacturing  ACCOUNT         │
│                                  As of: 18 Apr   │
└──────────────────────────────────────────────────┘
  FALCOR MARKETING CORPORATION          (bold 13pt)
  Code:     CA000196     Sales Rep:    JAN MICHAEL TORRE
  Address:  …, Manila    Credit Terms: 30 Days
  Tel:      …            Credit Limit: PHP 15,000,000.00
                          Status:       Active

  ┌─TOTAL AR─┐ ┌─CREDIT─┐ ┌─DSO────┐ ┌─LAST PAY─┐ ┌─LAST AMT──┐
  │ ₱11.10M │ │ 74.0%  │ │ 17 d   │ │ 17 Apr   │ │ ₱4.05M    │
  └──────────┘ └────────┘ └────────┘ └──────────┘ └───────────┘

  AGING BREAKDOWN
  ┌────────┬────────┬────────┬────────┬────────┬─────────┬────────┐
  │ Current│ 1–30 d │ 31–60 d│ 61–90 d│ 91–120 │ 121–365 │ Over 1Y│  ← navy hdr, white text
  ├────────┼────────┼────────┼────────┼────────┼─────────┼────────┤
  │ 6.77M  │ 4.34M  │   -    │   -    │   -    │   -     │   -    │  ← gray row
  │ 61.0%  │ 39.0%  │   0%   │   0%   │   0%   │   0%    │   0%   │
  └────────┴────────┴────────┴────────┴────────┴─────────┴────────┘

  ┌──────────┬──────┬────────┬─────────┬─────────┬─────────┬──────┬──────────┐
  │ Doc Date │ Doc# │ Type   │ DocTotal│ Paid    │ Balance │ Days │ Status   │ ← autoTable
  ├──────────┼──────┼────────┼─────────┼─────────┼─────────┼──────┼──────────┤
  │ …33 rows, oldest-unpaid first, zebra stripes, Status column color-coded: │
  │ Current=green · Watch=gold · Overdue=orange · Critical=red bold          │
  │                                          TOTAL OUTSTANDING  11,102,471.18│ ← nav footer
  └──────────┴──────┴────────┴─────────┴─────────┴─────────┴──────┴──────────┘

  ─────────────────────────────────────────────────────────────
  Remit to: BPI Account 123-45678-90 · Acct Name: VPI ·
  Generated by VieForce HQ · 18 Apr 2026, 09:32 · Page 1 of 2
```

**Filename:** `SOA_CA000196_FALCOR_MARKETING_CORPORATION_20260418.pdf`

**`didParseCell` hook** colors the Status column per status and the Days Old column by severity (>60 red, >30 orange). autoTable handles pagination automatically; the `didDrawPage` callback draws the footer on every page with correct `Page X of Y`.

### 2.3 Excel SOA

Built with **xlsx-js-style** (full cell styling, formulas, formats, merges, filters).

**Sheet 1 — "Summary" (A1:H24)**

| Row | Content | Style |
|---|---|---|
| 1   | VIENOVO PHILIPPINES INC.                   (merged A1:H1) | Deep Navy fill, white bold 14pt |
| 2   | STATEMENT OF ACCOUNT · As of 18 Apr 2026   (merged A2:H2) | Corporate Blue fill, white bold 11pt |
| 4–11| Customer info block (8 rows: Name, Code, Address, Tel, Rep, Terms, Limit, Status) | Right-aligned label + value, Credit Limit as PHP number format |
| 13  | SUMMARY                                    (merged A13:B13) | Deep Navy fill |
| 14–19 | 6 KPI rows: Total AR, Credit Used %, DSO, Last Pay Date, Last Pay Amt, Open Invoices | PHP fmt / percent fmt / plain |
| 21  | AGING BREAKDOWN                            (merged A21:G21) | Deep Navy fill |
| 22  | Current · 1–30 d · 31–60 d · 61–90 d · 91–120 · 121–365 · Over 1Y | Corporate Blue fill, white bold |
| 23  | PHP amounts                                | PHP number format `_(PHP* #,##0.00_);…` |
| 24  | Percentages                                | 0.0% italic gray |

**Sheet 2 — "Invoices"**
- Header row A1:J1 — Deep Navy fill, white bold, frozen (via `!views.frozen`)
- Auto-filter enabled on A1:J{N}
- Columns: Doc Date, Doc #, Type, PO Ref, Doc Total, Paid, Balance, Due Date, Days Old, Status
- Numeric columns use PHP format
- Status column color-coded: Current=`97D700`, Watch=`FFC72C`, Overdue=`F59E0B`, Critical=`EF4444`
- Total Outstanding row at bottom: "TOTAL OUTSTANDING" label (right-aligned, Deep Navy bold) + sum cell (Growth Green fill `E8F5D8`, PHP bold)
- Workbook metadata: Title, Author (VieForce HQ), Company (Vienovo Philippines Inc.), CreatedDate

**Filename:** `SOA_CA000196_FALCOR_MARKETING_CORPORATION_20260418.xlsx`

### 2.4 Modal UX

```
╭─ Generate Statement of Account ────────────  ×─╮
│ for FALCOR MARKETING CORPORATION                │
├─────────────────────────────────────────────────┤
│  ┌─────────────┐   ┌─────────────┐             │
│  │     📄     │   │     📊     │              │
│  │    PDF      │   │   Excel     │              │
│  │ Professional│   │  Editable   │              │
│  └─────────────┘   └─────────────┘             │
├─────────────────────────────────────────────────┤
│  Real-time AR from SAP · 60s cache              │  ← status line
╰─────────────────────────────────────────────────╯
    (centered, scaled-in with backdrop blur)
```

- Click **📄 PDF** → spinner → fetch `/api/customer/soa?id=` → generate → auto-download → status shows `✓ PDF downloaded (Xms) — SOA_...pdf`
- Click **📊 Excel** → same flow → `.xlsx` download
- **ESC** or click backdrop → close
- **×** button → close
- Disabled state during generation (prevents double-submit)
- Error state: red status text with message
- Success state: green status text with filename + elapsed ms

`CURRENT_CUSTOMER = { code, name }` is set by `openCust()` on customer-detail load. Modal refuses to open without a customer (safety).

---

## 3 · FEATURE 2 — Global Customer Search

### 3.1 Backend — `/api/search?q=FALC&type=customer`

- Minimum 2 chars; below that returns empty results.
- TOP 8 matches on `UPPER(CardCode) LIKE '%q%' OR UPPER(CardName) LIKE '%q%'`.
- Ranked by: exact code match → prefix name match → substring match → alphabetical.
- Each result enriched with: `sales_rep` (OSLP), dominant `region` (via WhsCode majority subquery, same Luzon/Visayas/Mindanao mapping as `/api/customers`), and `ytd_volume` (MT).
- 30s TTL cache, keyed by `search_customer_{q}`.

**Live sample:**
```
GET /api/search?q=FALC
{
  "results": [
    { "code":"CA000196", "name":"FALCOR MARKETING CORPORATION",
      "region":"Luzon", "ytd_volume":2169.8, "sales_rep":"JAN MICHAEL TORRE" }
  ],
  "query":"FALC", "type":"customer", "count":1
}

GET /api/search?q=METRO
  → 1 result: CA000372 METRO RETAIL SALES GROUP, INC.
```

### 3.2 UX

- Input: top-bar existing `#global-search`, placeholder unchanged.
- **300ms debounce** (`GS_STATE.debounceTimer`) — stale-response guard drops results if query has changed.
- Dropdown (`.gs-dropdown`) absolutely-positioned below input, 360px min, 420px max scroll.
- Row rendering:
  ```
  FALCOR MARKETING CORPORATION          ← bold 12px, matched substring wrapped in <mark>
  CA000196 · Luzon · 2169.8 MT YTD · JAN MICHAEL TORRE  ← mono 10px gray
  ```
- Active row highlighted Corporate Blue (`rgba(0,174,239,0.08)`).
- **Keyboard:** `↓/↑` navigate, `Enter` select, `ESC` close. `Tab` + blur closes after 160ms (gives time for row `mousedown` to fire).
- Click row → `gsSelect(code)` clears input + closes dropdown + calls `openCust(code)` (existing customer detail loader).
- Loading state: inline spinner "Searching…".
- Empty state: "No matches for "xyz"".

---

## 4 · FEATURE 3 — Inventory Drill-Down

### 4.1 State & filter model

```
INV_FILTER = { region: null, plant: null }
plantRegionOf(wh)  // AC/ACEXT/BAC → Luzon · HOREB/ARGAO/ALAE → Visayas
                   // BUKID/CCPC → Mindanao · else → Other
                   // (same mapping as /api/inventory by_region CASE)
```

### 4.2 Interaction

- **Click BY REGION row** → `applyInvFilter('region', 'Luzon')`:
  - Sets `INV_FILTER.region = 'Luzon'`
  - Clears `INV_FILTER.plant` if the plant isn't in Luzon
  - Re-renders BY PLANT (filtered to Luzon plants) and BY PRODUCT (filtered to items in Luzon plants)
  - Adds active highlight (`.drill-active`) on the clicked region row
- **Click BY PLANT row** → `applyInvFilter('plant', 'HOREB')`:
  - Sets plant + auto-sets region to match (`plantRegionOf`)
  - BY PRODUCT table filters to HOREB-only SKUs
- **Click active row again** → toggles off (removes that filter).
- **Filter pills** rendered in `#inv-filter-bar` above KPIs:
  - `Region: VISAYAS ×`   (click × → removes region filter)
  - `Plant:  HOREB ×`
  - `[ Clear all ]` button appears once 2+ filters active
- **URL hash persistence** via `history.replaceState`:
  - `#pg-inv`                          — no filter
  - `#pg-inv?region=Visayas`           — region only
  - `#pg-inv?region=Visayas&plant=HOREB` — both
  - On page load (`loadInvFromHash()`), filters are restored from hash → shareable views.

### 4.3 Rendering changes

- **`renderInv()` BY REGION loop** adds `class="drill-clickable"` + `onclick` to every data row; active row gets extra `drill-active` class (3px Corporate Blue left-border glow).
- **`renderInv()` BY PLANT loop** filters `plants[]` by `plantRegionOf(plant_code) === INV_FILTER.region` when a region is set. Empty-state message if no plants match. "Subtotal" row replaces "Grand total" when filtered.
- **`renderInvProducts()`** filters `items[]` upfront by both `INV_FILTER.plant` (exact plant_code match) and `INV_FILTER.region` (plantRegionOf match).
- The product table's **Plant column** automatically shows the single plant code when filtered, else "N plants" (via existing aggregation logic).
- **No extra API calls** during filter changes — pure client-side re-render against the already-cached `/api/inventory` response. Filter switches are sub-frame.

---

## 5 · Deployment

| Step | Artifact | Result |
|---|---|---|
| 1 | `git commit 7686bac` + push origin | ✓ |
| 2 | `gcloud run deploy --source . --no-traffic --tag preview` | ✓ rev **`00049-fof`** |
| 3 | Preview smoke — FALCOR SOA | ✓ total_ar=₱11,102,471.18 · 33 invoices · dso=17 · last_pay=2026-04-17 |
| 4 | Preview smoke — Search FALC / METRO | ✓ 1 result each, ranked correctly |
| 5 | Preview smoke — all 9 existing endpoints | ✓ dashboard/sales/ar/inventory/speed/customers/margin/intelligence/team all HTTP 200 |
| 6 | `gcloud run update-traffic --to-revisions 00049-fof=100` | ✓ **100% prod traffic** on `00049-fof` |
| 7 | Prod smoke — `/api/customer/soa?id=CA000196` | ✓ total_ar=₱11,102,471.18 · 33 invoices |
| 8 | Prod smoke — `/api/search?q=FALC` | ✓ 1 result FALCOR |
| 9 | `vercel --prod --yes` + alias | ✓ **https://vieforce-hq.vercel.app** |
| 10 | Vercel prod — string match on `jspdf`/`xlsx-js-style`/`customer-soa`/`gs-dropdown`/`soa-backdrop` | ✓ 19 matches — all Track 2 markup shipped |

### Rollback if needed

```bash
gcloud run services update-traffic vieforce-hq-api \
  --region asia-southeast1 \
  --to-revisions vieforce-hq-api-00045-guw=100 --quiet
```

(00045-guw = last Track 1 revision)

---

## 6 · Manual verification checklist

Open **https://vieforce-hq.vercel.app** (incognito + Ctrl+Shift+R).
Login phone `09170000100`.

### SOA PDF
1. Customers → FALCOR MARKETING (or use top search: type "FALC" → Enter)
2. Scroll to AR Aging card → click **Issue SOA**
3. Modal opens, subtitle reads "for FALCOR MARKETING CORPORATION"
4. Click **📄 PDF**
5. File `SOA_CA000196_FALCOR_MARKETING_CORPORATION_20260418.pdf` downloads in ~400-800ms
6. Open — verify:
   - [ ] Deep Navy header band · VPI logo box · SOA title right
   - [ ] FALCOR name + code + address + sales rep block
   - [ ] 5-card summary strip: AR ₱11.1M · Credit 74% · DSO 17d · Last Pay 17 Apr · ₱4.05M
   - [ ] Aging row: Current ₱6.77M (61%) + 1-30 ₱4.34M (39%)
   - [ ] Invoice table (33 rows), zebra stripes, oldest first, Status column color-coded
   - [ ] TOTAL OUTSTANDING ₱11,102,471.18 bold at bottom
   - [ ] Page X of Y footer with remit-to line

### SOA Excel
1. Same flow, click **📊 Excel**
2. `SOA_CA000196_FALCOR_MARKETING_CORPORATION_20260418.xlsx` downloads
3. Open — verify:
   - [ ] Sheet 1 "Summary": Deep Navy header bar, Corporate Blue subheader, customer info block, 6-row KPI, Aging row with PHP format + percentages
   - [ ] Sheet 2 "Invoices": frozen header, auto-filter, 33 rows, Status color-coded, PHP format on amount cols, TOTAL row with green-tinted sum

### Global customer search
1. Top-bar search → type "FALC"
2. Within ~500ms dropdown shows 1 result highlighted `FALC`or
3. Keyboard: `↓` highlights row, `Enter` navigates to FALCOR detail
4. `ESC` closes dropdown
5. Type "SAN" → multiple matches; arrow keys cycle

### Inventory drill-down
1. Navigate to Inventory
2. Click **HOREB** in By Plant → pill "Plant: HOREB" appears, By Product filters to HOREB SKUs only
3. Region pill also appears (auto-set to Visayas)
4. Click VISAYAS in By Region → stays (already active)
5. Click LUZON → region swaps, HOREB plant filter auto-clears (not in Luzon)
6. Click × on "Plant: HOREB" → removes just that filter
7. Click "Clear all" (when both active) → all reset
8. URL hash updates to `#pg-inv?region=Luzon&plant=AC` live; paste in new tab → state restores

---

## 7 · Performance

| Operation | Measured |
|---|---|
| `/api/customer/soa?id=CA000196` cold (preview) | ~2.8s (first call, DB warm-up) |
| `/api/customer/soa?id=CA000196` warm (60s cache hit) | ~80ms |
| `/api/search?q=FALC` cold | ~1.1s |
| `/api/search?q=FALC` warm (30s cache hit) | ~70ms |
| PDF generation (33 invoices) | ~450–700ms browser-side |
| Excel generation (33 invoices) | ~220–400ms browser-side |
| Inventory filter click → re-render | < 50ms (no API call) |
| Global search debounce to dropdown paint | 300ms + ~1s first call, ~70ms cached |

---

## 8 · Caveats / follow-ups

1. **OCRD.Address** can be long on some customers (multi-line). Current PDF concatenates Address + City and may overflow if > ~60 chars. Follow-up: truncate or wrap.
2. **Bank details placeholder** ("BPI Account 123-45678-90") is a literal per spec — swap to real account when Mat/Finance provides.
3. **Customer email** returned in API but not shown in PDF/Excel (spec didn't include). Trivial to add if desired.
4. **`po_ref` (NumAtCard)** is included in Excel Sheet 2 but omitted from PDF to keep columns readable on A4. Available if we go landscape later.
5. **Inventory drill `Other` region** covers 30+ plants not in the hardcoded mapping (e.g. CCPC-BRANCH, SOUTH, ARGAO-2 variants). Clicking "Other" will correctly filter to those. The mapping in `plantRegionOf` mirrors the API's `by_region` CASE — if the API is extended, duplicate the change here.
6. **Global search** is customer-only in v1. `type=sku` will 200 with `{ results: [], note: 'Only type=customer supported in v1' }` — extend in a follow-up if Mat wants inventory SKU search.
7. **xlsx-js-style bundle size** (~900KB min) is slightly larger than plain xlsx (~680KB). Load-once CDN cached; no measurable impact on subsequent sessions.

---

## 9 · URLs

| | |
|---|---|
| Production frontend | https://vieforce-hq.vercel.app |
| Production API      | https://vieforce-hq-api-qca5cbpcqq-as.a.run.app (100% → `vieforce-hq-api-00049-fof`) |
| Preview API (same rev) | https://preview---vieforce-hq-api-qca5cbpcqq-as.a.run.app |
| GitHub branch       | `design-upgrade` @ `7686bac` |

---

*Generated by Track 2 Agent — 2026-04-18*
