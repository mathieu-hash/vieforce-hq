# QUICK WINS REPORT — 6 Visible Polish Wins

**Date:** 2026-04-17
**Branch:** `design-upgrade`
**Commit:** `7205708` — "Quick Wins Sprint: fonts, Joel/Rachel cleanup, exports, chart polish, AR search"
**Vercel preview:** `https://vieforce-4b1kqi0ke-mathieu-7782s-projects.vercel.app`
**Cloud Run:** unchanged (`vieforce-hq-api-00030-man`, frontend-only sprint)

---

## 1. Files Modified

| File | Change |
|------|--------|
| `app.html` | CSS (table fonts + export-btn pill), head tags (chartjs-plugin-datalabels + xlsx CDNs), L10 Scorecard markup (Joel removed + Rachel row deleted), Team hero copy, Home chart configs, AR Top Clients card markup, new JS helpers (exportTableToXlsx / exportNearestTable / injectExportButtons / renderARClients / sortARClients / setARFilter), loadAR caches `AR_CLIENTS_CACHE` |

No backend files changed. No `_auth.js` / `_db.js` touched.

---

## 2. Each Win — Before → After

### Win 1 — Table fonts

| Selector | Before | After |
|----------|--------|-------|
| `.tbl` | `font-size:12px` | `font-size:13px` |
| `.tbl th` | `font-size:10px`, `letter-spacing:0.5px` | `font-size:11px`, `letter-spacing:0.08em` |
| `.tbl td` | — | `line-height:1.6` added |
| `.tbl .num` | `font-size:12px` | `font-size:14px` + `font-variant-numeric:tabular-nums` |
| **new** `.tbl .big-num` | — | `font-size:15px` `font-weight:600` tabular-nums (applied to AR client's main balance cell) |

Result: numbers are noticeably larger and columns align perfectly (tabular-nums prevents digit-width drift).

### Win 2 — Remove "Joel Durano" name

| Location | Before | After |
|----------|--------|-------|
| Team EVP hero | `Joel Durano — EVP Sales & Marketing` | `EVP Sales & Marketing — National Overview` |
| Team hero avatar | `JD` (gradient circle) | `EVP` (same circle) |
| L10 Scorecard card title | `📊 L10 Scorecard — Joel Durano, EVP Sales` | `📊 L10 Scorecard — EVP Sales & Marketing` |
| L10 Owner column | `Joel` (each measurable row) | **unchanged** — correct per brief |

### Win 3 — Remove Rachel row from L10

Deleted the `<tr>` for "Rachel / No Shortage (RM) / number / 0 …" (15 weekly cells). Rachel is Raw Materials, not Sales — doesn't belong in Sales L10.

### Win 4 — Export buttons (XLSX)

**Added:**
```html
<script src="…chartjs-plugin-datalabels@2"></script>
<script src="…xlsx@0.18.5/dist/xlsx.full.min.js"></script>
```

**Pill style** (Growth Green on transparent):
```css
.export-btn{padding:4px 10px;border-radius:20px;background:transparent;
            border:1px solid rgba(151,215,0,0.3);color:var(--green);
            font-size:10px;font-weight:700;...}
.export-btn:hover{background:rgba(151,215,0,0.1);border-color:var(--green)}
```

**Auto-injection:** `injectExportButtons()` walks every `.card` that has both a `.card-hdr` and a `<table>` inside `.card-body`, and appends one pill button per card. Runs:
- Once on `initApp()` (after first render)
- Again after every DOM mutation (via `MutationObserver`, debounced 150ms) — so dynamically-built tables (RSM Scorecard, AR Clients, Intelligence Brand Coverage, etc.) all get the button once data arrives.

**Filename pattern:** `VieForce_HQ_{PageName}_{TableTitle}_{YYYYMMDD}.xlsx`
Example: `VieForce_HQ_Ar_Clients___AR_20260417.xlsx` for the AR Clients table.

**Test:** Opening the downloaded file in Excel shows the exact table contents as plain rows (column headers preserved). **Branded Excel styling (Deep Navy header row, Growth Green totals) is not applied** — requires `xlsx-js-style` (commercial licensing concern) or manual cell.s styling. **Flagged for a future Vienovo-branded export pass.**

Current: functional XLSX download with all rows/columns. Mat can copy-paste into a branded template.

### Win 5 — Home charts

**Before:** CY Volume bars in Deep Navy, LY bars in same Deep Navy at 20% opacity — colors blurred together. GM line's custom data labels (canvas `fillText`) overlapped the right-axis labels and had no background.

**After (dark mode):**
- CY Vol: `rgba(0,174,239,0.9)` — **Corporate Blue** high contrast
- LY Vol: `rgba(0,174,239,0.25)` — translucent "ghost" of CY
- GM line: `#97D700` · borderWidth **3** · tension **0.35** · points `pointRadius:4`
- GM data labels (chartjs-plugin-datalabels): `backgroundColor: rgba(0,42,58,0.92)` (Deep Navy pill), `color: #97D700`, `borderRadius: 4`, `padding: 2px 6px`, `font: 700 11px` — positioned `align:'top', offset:8`
- Added `layout:{padding:{top:24}}` so labels have space above the chart area (no overlap with right axis)

**Light mode** (auto via `homeChartColors()`):
- CY Vol: `rgba(0,74,100,0.9)` — **Deep Navy**
- LY Vol: `rgba(0,74,100,0.2)` — ghosted Deep Navy
- GM line: `#7AB800` (darker green, readable on white)
- GM pill: white background, `#005F33` text, `#97D700` border

Old custom `labelPlugin` that used canvas `fillText` was removed — replaced by chartjs-plugin-datalabels with proper background/offset.

### Win 6 — AR client search + filter + sort

**Added in Top Clients card header:**
- Search input (right-aligned): "Search customer by name or code…" — filters `AR_CLIENTS_CACHE` as you type. × clears.
- Filter pills row: **All** / **Active only** / **Delinquent only** / **Overdue > 0** (Corporate Blue bg on active).
- Client count display on right: `"42 of 678 clients"`.

**Sortable columns** (click any `<th>`):
- Client (by name)
- AR (balance) — default desc
- Current · Overdue · Falling Due · New Overdue · Aging (days_overdue)
- Click active column toggles asc ↔ desc. Inactive columns have no arrow; active shows ▲ or ▼.

**Architecture:** client-side only. `loadAR()` caches `d.clients` into `AR_CLIENTS_CACHE`. `renderARClients()` rebuilds the tbody from cache + current filter/sort/search. No re-fetch on every keystroke — instant.

**Region filter** was **not added** — API `clients[]` doesn't currently expose a per-client region (needs `WhsCode → Region` JOIN on dominant invoice). **Flagged for Track B.**

---

## 3. Tables that will get an auto Export button (partial list)

Every `.card` with a `.card-hdr` and `<table>` now shows the Export pill. Verified tables include:
- **Home**: Region Performance
- **AR**: 7-bucket Aging · AR by Region · Top Clients · DSO Variation (no table, skipped) · AR Variation (no table, skipped)
- **Sales**: Customer Rankings
- **Inventory**: prototype tables (no tbody IDs yet — button still appears and exports what's rendered)
- **Speed**: RSM Speed · Feed Type Speed · Weekly Matrix · Plant Matrix
- **Customer Detail**: Monthly Breakdown · AR Aging
- **Margin**: Warning · by_region · by_brand · by_plant · Worst SKUs
- **Intelligence**: Brand Coverage · Horizontal Targets · Buying Patterns · SKU Penetration matrix
- **Team**: RSM Scorecard · Account Health by RSM · Volume by BU × Region (prototype) · Performance Matrix
- **Budget**: Budgeted Volume · P&L summary · Volume Achievement · GM Achievement

(~25+ tables total get a button. Spec asked to test ONE and verify .xlsx opens — done: valid workbook with table rows.)

---

## 4. Deployment

| Target | Value |
|--------|-------|
| Vercel preview | `https://vieforce-4b1kqi0ke-mathieu-7782s-projects.vercel.app` |
| Cloud Run | Unchanged (`vieforce-hq-api-00030-man`) — no backend changes |

---

## 5. What Mat should check (incognito + Ctrl+Shift+R)

Open **https://vieforce-4b1kqi0ke-mathieu-7782s-projects.vercel.app**

- [ ] **Font size:** any table (Home Region, AR Top Clients, Margin Warning) — numbers are visibly larger and tabular-aligned.
- [ ] **Team page:** Hero says "EVP Sales & Marketing — National Overview" with "EVP" avatar. No "Joel Durano" anywhere in hero or card titles. L10 Scorecard title reads "— EVP Sales & Marketing". The Owner column still shows "Joel" on each row (correct).
- [ ] **L10 Scorecard:** Rachel row is gone. Only 5 Joel rows remain (National / Visayas / Mindanao / Luzon / GM).
- [ ] **Export button:** go to AR → Top Clients card → click the green **⬇ Export** pill (top-right of card) → a file `VieForce_HQ_Ar_Clients___AR_20260417.xlsx` downloads → opens cleanly in Excel with the current filtered+sorted rows.
- [ ] **Home charts:** Monthly and Quarterly — CY bars (Corporate Blue) clearly distinct from LY bars (ghosted). GM line is a solid Growth Green with pill-labelled values (₱60M, ₱66M, …) that sit above the line, no overlap with the right axis.
- [ ] **AR Top Clients:**
   - Search box — type "feeds" or a CardCode prefix → table filters instantly.
   - Filter pills — click "Delinquent only" → only delinquent rows show; count updates.
   - Column sort — click "Aging" header → rows re-sort by days_overdue; ▼ appears in header. Click again → ▲, asc.
   - Count shows "N of M clients" at top right.

---

## 6. Known Caveats

1. **XLSX export is unstyled.** Rows/columns export faithfully but no Vienovo branding colors in the Excel file. Needs `xlsx-js-style` for cell-level colors (not included — commercial/complex to configure). Flag for a Vienovo-branded export pass.
2. **AR region filter not implemented.** Backend `clients[]` has no region field. Will need an API change in Track B (`WhsCode → Region` join on dominant invoice or OCRD.U_Region if that UDF exists).
3. **Export button on tables without semantic header row** may include only `<tbody>` rows without column headers in the resulting Excel — this is a SheetJS `table_to_book` limitation when the `<thead>` isn't wrapped. Most of my recently-rewired tables have proper `<thead>` + `<tbody>`, so this only affects older prototype tables that were never refactored.
4. **Auto-inject uses MutationObserver** at `document.body` scope — minor CPU when navigating. If this becomes noticeable, scope the observer to the `.content` container only.

---

*Generated by Quick Wins Agent — 2026-04-17*
