# ITEMIZED SALES — Tab Build Report

**Date:** 2026-04-17
**Branch:** `design-upgrade`
**Commits:** `ebaccf9` (scaffold) · `1f827f4` (SAP description classifier fix) pushed
**Cloud Run revision:** `vieforce-hq-api-00035-bac` · `https://preview---vieforce-hq-api-qca5cbpcqq-as.a.run.app`
**Vercel preview:** `https://vieforce-ngd8xy3nr-mathieu-7782s-projects.vercel.app`

---

## 1. Files Created / Modified

### New files
| File | Purpose |
|------|---------|
| `api/itemized.js` | Main endpoint — SQL + classifier + shape builder |
| `api/itemized-meta.js` | Lightweight dropdown populator (districts + managers) |
| `api/data/product_hierarchy.json` | 224 SKUs × 10 top-level groups × 13 sub-groups extracted from reference Excel |
| `api/data/district_managers.json` | 48 sheet → manager name mappings (R1 col A) |
| `api/data/district_list.json` | Sections grouped for dropdown: 25 districts, 7 KAs, 3 Pet, 2 Other, 11 Totals |
| `scripts/parse-itemized-ref.js` | Node/xlsx script that regenerates the 3 JSONs from the reference Excel |
| `scripts/inspect-ref.js` | Debug helper (row dump) |
| `docs/reference/Itemized_Sales_Forecst_Per_District_2025_v2.xlsx` | Authoritative reference file (copied from GDrive) |

### Modified files
| File | Change |
|------|--------|
| `server.js` | Registered `/api/itemized` and `/api/itemized/meta` routes |
| `js/api.js` | Added `getItemizedData()` helper |
| `app.html` | Added `pg-itemized` page, `.itm-tbl` CSS system, nav click wiring, title map, route case, full client logic (`ITM_STATE`, `loadItemized`, `renderItemized`, `setItemizedUnit`, `toggleItemizedGroup`, `exportItemizedXlsx`) |
| `api/diag.js` | Added `_item_probe` + `_item_count` for future tuning |

---

## 2. SQL Query (production)

```sql
SELECT
  T1.ItemCode                                                       AS item_code,
  MAX(I.ItemName)                                                   AS item_name,
  MAX(I.SWeight1)                                                   AS weight_per_bag_kg,
  MAX(I.NumInSale)                                                  AS num_in_sale,
  MONTH(T0.DocDate)                                                 AS month,
  YEAR(T0.DocDate)                                                  AS year,
  ISNULL(SUM(T1.Quantity), 0)                                       AS bags,
  ISNULL(SUM(T1.Quantity * ISNULL(I.NumInSale, 1)) / 1000.0, 0)     AS mt
FROM OINV T0
INNER JOIN INV1 T1 ON T0.DocEntry = T1.DocEntry
LEFT JOIN OITM I   ON T1.ItemCode = I.ItemCode
WHERE T0.CANCELED = 'N'
  AND YEAR(T0.DocDate) IN (@year, @cy)
  AND UPPER(T1.ItemCode) LIKE 'FG%'
GROUP BY T1.ItemCode, MONTH(T0.DocDate), YEAR(T0.DocDate)
```

**Execution:** 279ms on live SAP, 211 SKUs × 12 months × 2 years → ~5K rows aggregated.

---

## 3. Sample Response (TOTAL NATIONAL 2026)

```
district:         TOTAL NATIONAL 2026
district_manager: (null — totals row)
active SKUs:      211 / 211
total MT CY:      55,767.6   total Bags CY: 1,202,625
vs LY:            null (no 2025 SAP data)
query_ms:         279   total_ms: ~290

Groups by MT CY
  POULTRY          27,587.8 MT   36 SKUs  (VIEPRO-BROILER + VIEPRO-LAYER)
  VIEPRO           17,187.3 MT  150 SKUs
  VIEPRO PRIME      6,255.3 MT    4 SKUs
  VIEPRO PROMO      2,336.6 MT    6 SKUs
  OTHERS            1,353.0 MT    3 SKUs  (PDP + GAMEFOWL + OTHERS)
  PROBOOST            943.9 MT    3 SKUs
  VIETOP              103.7 MT    9 SKUs
  PRIVATE LABEL         0.0 MT    0       (no invoices tagged this way)
  AQUA                  0.0 MT    0       (no VANA/shrimp invoice activity 2026)
  PET FOOD              0.0 MT    0       (KEOS/NOVOPET/PLAISIR not matching FG% prefix)

Form summary
  Pellets            41,834.2 MT    893,456 bags   (76% of volume)
  Crumbles            8,123.8 MT    177,500 bags
  Mash                5,204.3 MT    109,100 bags
  Ready Mix             605.3 MT     22,569 bags
  Extruded / Grains / Wet Products = 0
```

Sample SKU rows (VIEPRO PRIME):
```
FG000365  VIEPRO PRIME GESTATING PELLET    5,047.5 MT   100,950 bags
FG000371  VIEPRO PRIME LACTATING PELLET      840.9 MT    16,818 bags
FG000362  VIEPRO PRIME GESTATING MASH        273.9 MT     5,478 bags
FG000369  VIEPRO PRIME LACTATING MASH         93.0 MT     1,860 bags
```

Other districts (e.g. CEBU NORTH) return the full 10-group structure with zero volumes + `district_mapping_pending: true` + manager name (e.g. "LAWRENCE ALO") + the amber Phase-1 banner.

---

## 4. How Product Hierarchy Was Extracted

`scripts/parse-itemized-ref.js` reads the reference `.xlsx` with the `xlsx` Node package:

1. Iterates all 48 sheets, grabs `A1.v` of each → `district_managers.json`
2. Classifies sheet name into section (`TOTAL` / `DISTRICT` / `KEY_ACCOUNTS` / `PET` / `OTHER`) → `district_list.json`
3. Walks rows 1–289 of the reference sheet (`CEBU NORTH`) using these rules:
   - **SKU row** = col B matches `/^vpi\d+/i`
   - **Form summary row** = col C ∈ `{Pellets, Crumbles, Mash, Extruded, Grains, Ready Mix, Wet Products}`
   - **Grand total row** = col C === `TOTAL`
   - **Top-level group header** = col C in explicit list `{VIEPRO, VIEPRO PRIME, VIEPRO PROMO, VIETOP, POULTRY, OTHERS, PROBOOST, PRIVATE LABEL, AQUA, PET FOOD}` and not yet seen
   - **Sub-group header** = any other uppercase-looking label following a top-level group (e.g. `VIEPRO - BROILER`, `KEOS - DOG`, `PDP`)
4. Emits `product_hierarchy.json` with `skus` (keyed by Excel `vpi…` code) + `structure` (nested groups/sub-groups for UI rendering).

Output: **224 SKUs**, **10 top-level groups**, **13 sub-groups** (POULTRY×2, OTHERS×3, AQUA×1, PET FOOD×7).

---

## 5. Excel Export

**Button:** `⬇ Export Excel` top-right of controls bar.
**Library:** SheetJS (already loaded globally from the Quick Wins sprint CDN).
**Filename pattern:** `VPI_Itemized_{District}_{Year}_{YYYYMMDD}.xlsx`
  Example: `VPI_Itemized_TOTAL_NATIONAL_2026_2026_20260417.xlsx` (~80KB)

**Structure matches reference:**
- R1 col A: district manager name · col D: "VIENOVO PHILIPPINES INC."
- R2 col E: "IN BAGS ({year})" · col S: "IN METRIC TONS ({year})"
- R3: column headers (Code / ItemCode / Product / kg / Jan–Dec+Total × 2)
- Group rows: group name in col C
- SKU rows: ItemCode / ItemName / NumInSale / 12 monthly bags + total / 12 monthly MT + total
- Form Summary block (7 rows)
- Grand TOTAL row

**Vienovo branded cell colours (Deep Navy group headers, Growth Green total) — not applied** because `xlsx-js-style` fork is commercial-licensed / adds weight. Plain SheetJS export preserves the exact structure; colours can be layered on in a follow-up.

---

## 6. PHASE 1 Limitations

| Item | Status | Fix in |
|------|--------|--------|
| District-level SAP data (24 districts + 7 KAs + 3 Pet) | ⚠ Structure-only | v1.1 — needs `SlpCode → district` or `CardCode → district` mapping from Mat |
| PET FOOD / AQUA / PRIVATE LABEL have 0 volumes | ⚠ Classifier miss | KEOS / NOVOPET / PLAISIR items may use a different SAP prefix than `FG%`. Diag probe needed to find their real prefix (e.g. `PK%`, `KT%`, or numeric-only). |
| vs LY deltas | ⚠ null | No 2025 invoice rows in Vienovo_Live. Natural once SAP is back-filled. |
| Excel cell colours | ⚠ Plain export | Add `xlsx-js-style` CDN + inline cell.s objects to render Deep Navy group rows + Growth Green totals. |
| Sticky-column z-index inside grouped rows | ⚠ Minor visual — group header spans full width and overlays sticky columns on scroll. Acceptable for v1. |
| vpi → FG mapping | ⚠ Structure is built from live SAP items, not the Excel's vpi-coded rows. SKU count per group may differ from the Excel's hand-curated list. |

---

## 7. Performance

| Metric | Value |
|--------|-------|
| SAP query time | **279 ms** (TOTAL NATIONAL, 2 years) |
| Total endpoint time | ~290 ms (first call) |
| Cache TTL | 600 s (10 min) |
| Response size | 93 KB uncompressed JSON |
| Frontend render time | < 200 ms for 211-SKU table (tested locally) |

---

## 8. Deployment

| Target | Value |
|--------|-------|
| Cloud Run preview | `vieforce-hq-api-00035-bac` · 0% traffic · `https://preview---vieforce-hq-api-qca5cbpcqq-as.a.run.app` |
| Vercel preview | `https://vieforce-ngd8xy3nr-mathieu-7782s-projects.vercel.app` |
| Production | Untouched |

---

## 9. What Mat should see

**Open in incognito + Ctrl+Shift+R:**
**https://vieforce-ngd8xy3nr-mathieu-7782s-projects.vercel.app**

Login: `09170000100` + your PIN.

Click **🗂 Itemized Sales** in sidebar (under REPORTS).

Default view: **TOTAL NATIONAL 2026**.

Test:
- [ ] **District dropdown** — grouped optgroups: DEFAULT · REGIONAL TOTALS · DISTRICTS · KEY ACCOUNTS · PET · OTHER. Pick "CEBU NORTH" → manager reads "LAWRENCE ALO", amber Phase-1 banner appears, structure shows all 10 groups with zero volumes.
- [ ] **Switch back to TOTAL NATIONAL 2026** → 55,768 MT YTD visible in KPI strip. POULTRY group expands to 36 SKUs across VIEPRO-BROILER + VIEPRO-LAYER sub-groups.
- [ ] **Click a group header** (e.g. POULTRY) → rows collapse; triangle flips ▶. Click again → ▼ expand. State persists on reload.
- [ ] **Search box** — type "PIGLET" → only piglet SKUs visible across groups. Type "layer" → only layer feed SKUs.
- [ ] **BAGS / MT toggle** — numbers reformat (bags are integers, MT carries 1 decimal).
- [ ] **vs LY checkbox** — tick/untick reveals 12 LY columns + vs LY % column (currently all 0% because 2025 SAP data isn't loaded).
- [ ] **Export Excel** — a `.xlsx` file downloads, opens in Excel with the matching structure: manager name R1, IN BAGS / IN METRIC TONS banners R2, Jan-Dec columns × 2, group header rows, all 211 SAP SKUs with monthly detail, form summary rows, grand total.
- [ ] **Print button** — browser print dialog opens; CSS hides sidebar/topbar/controls for clean print.
- [ ] **KPI strip** — District Volume YTD shows 55.8K MT · Active SKUs 211 / 211 · Top Brand POULTRY (~50% share).

---

*Generated by Itemized Sales Agent — 2026-04-17*
