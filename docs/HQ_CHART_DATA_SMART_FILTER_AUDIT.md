# HQ Chart/Data Smart Filter Audit

Date: 2026-05-19  
Scope: Entire VieForce HQ app, with emphasis on chart data, filters, linked drilldowns, heavy windows, and sales/CEO usability.

## Executive Summary

The current HQ app should not be replaced by the EVP prototype. The right move is to keep the original dark dashboard design language and improve the app underneath: cleaner data contracts, fewer first-load payloads, smarter global filters, linked drilldowns, and expandable detail panels.

The biggest issue is not visual design. It is data truth and interaction architecture:

1. Volume is not consistently sourced across pages. Home and Speed are moving toward ODLN delivery notes as the physical shipped volume source, while Sales, Budget, Margin, Customer, and several detail pages still use OINV invoice rows.
2. Budget exists, but it is duplicated in several APIs with different monthly phasing. `api/budget.js` appears to be the most complete source, but `dashboard.js`, `speed.js`, and `team.js` still carry their own hardcoded budget constants.
3. Period logic is inconsistent. `_auth.getPeriodDates('7D')` creates an 8-date inclusive window, while `shipping_days.getPeriodBounds('7D')` creates a true 7-day window.
4. Key Accounts vs Distribution is not yet a first-class global segmentation. Some analytics endpoints use KA SlpCodes, but most HQ pages do not expose or honor this segmentation consistently.
5. Some pages load too much at once. Home, Insights, Team, AR, Margin, Sales pending PO, and Itemized should move to summary-first loading with expandable details.
6. Inventory already has the best drilldown pattern in the app: local filter state plus URL hash deep links. This should become the shared HQ interaction model.

The goal should be: one HQ app, one filter spine, one budget source, one period helper, clear source/proxy flags, and panel-level lazy loading.

## Current HQ App Map

| Page | Current role | What should change |
| --- | --- | --- |
| Home | National executive overview | Keep as the top executive cockpit, but reduce first load and make cards filter-aware. |
| EVP Home | Sales leadership view | Convert into a CEO/EVP Sales Command page, not a second full HQ. |
| RSM Home | Regional manager landing | Keep role view, but make targets and source badges explicit. |
| DSM Home | District/DSM landing | Needs reliable DSM district mapping and budget source before showing achievement as real. |
| Sales | Sales, customer, brand, PO detail | Add monthly volume/speed chart, KA vs Distribution filter, expandable PO detail. |
| AR | Receivables and DSO | Add server-side paging, clickable aging buckets, SOA/customer drill links. |
| Inventory | Stock, plants, production | Keep current drilldown pattern; generalize it to the rest of HQ. |
| Speed | Daily/weekly pullout and projections | Make this the canonical speed/projection source. Add segment/region/district/brand filter support. |
| Customers | Customer list/search | Already has server-side paging; add segment and period context. |
| Customer Detail | 360 view | Load summary first, then AR/SOA/product history lazily. |
| Margin | Margin guardrails | Keep as risk page, but stream heavy tables and label proxies. |
| Insights | Growth, rescue, warning, deeper analytics | Split hero alerts from deeper analytics; do not auto-load all deep panels. |
| Team | EVP/RSM/DSM performance | Needs real target source below national level; lazy-load DSM details. |
| Budget | Budget scorecard/P&L | Centralize all budget data here; sales dashboards should consume the same helper. |
| Itemized | Product matrix | Useful deep dive, but district data is pending except national. Make this clearer and lazy-load detail. |

## Critical Data Findings

### 1. Volume source must be standardized

Use this rule everywhere:

| Metric | Canonical source | Notes |
| --- | --- | --- |
| Shipped volume / DR volume / pullout / speed | ODLN | This matches the user's daily Looker Studio expectation. |
| Net sales | OINV | Invoice value. |
| Gross margin | OINV | Invoice margin. |
| GM/T | OINV GM divided by OINV volume | Keep this transparent because shipped volume and invoiced volume can differ. |
| Pending billing | ODLN open delivery notes | Useful operational bridge. |

Home already documents this rule in `api/dashboard.js`. Speed uses ODLN throughout. Sales, Budget, Customer, Margin, and several detail tables still rely heavily on OINV volume, so page labels must be explicit until unified.

### 2. Budget data is real, but duplicated

`api/budget.js` contains the most complete budget model:

- FY target MT: 188,266
- FY sales target: 5.975B PHP
- FY GM target: 1.233B PHP
- Monthly phasing: exact monthly values
- Region budgets: Luzon, Visayas, Mindanao

But other APIs have separate budget constants:

- `api/dashboard.js`
- `api/speed.js`
- `api/team.js`

This creates risk that two pages show different target, budget pace, or achievement for the same period. Create one shared budget helper, for example `api/lib/budget_2026.js`, and make every endpoint consume it.

### 3. 7D logic is inconsistent

`api/_auth.js` defines 7D as `anchor - 7` through anchor, which is 8 inclusive calendar dates when used with SQL `BETWEEN`. `api/lib/shipping_days.js` defines 7D as `anchor - 6` through anchor, which is a true 7-day inclusive window.

This matters because the user explicitly wants 7D for weekly scorecard monitoring. Fix this before comparing pages.

### 4. Region, district, DSM, and warehouse are different concepts

Many current region views are derived from warehouse code. That is valid for shipping/logistics, but it is not the same as customer ownership, DSM territory, or budget ownership.

The app should label the dimension clearly:

| Label | Meaning |
| --- | --- |
| Shipping Region | Derived from WhsCode/plant/warehouse. |
| Customer Region | Dominant customer region from invoice/shipment history. |
| Sales Region | RSM/DSM ownership from sales hierarchy. |
| Budget Region | Official budget region allocation. |

Do not let a warehouse-based region table silently drive a DSM or budget conclusion.

### 5. Key Accounts vs Distribution must become first-class

The screenshots and user feedback make this non-negotiable: Key Accounts and Distribution are different business models. The current analytics endpoints have a partial KA classifier using SlpCodes `2`, `7`, and `24`, plus name matching. This is a good starting point, but it should move into a shared helper and become a global filter.

Recommended global segment options:

- All Segments
- Distribution
- Key Accounts
- Pet Care
- Employees/Internal if still required for customer mix

The app should never bury Key Accounts inside a generic customer table. It should be an explicit segmentation chip and every chart should state whether it is filtered to Distribution, KA, or all.

## Smart Filter And Link Model

### Current state

The topbar currently has:

- Period: `7D`, `MTD`, `QTD`, `YTD`
- Compare: `vs PP`, `vs LY`
- Unit: `MT`, `Bags`
- Region: `ALL` plus region dropdown
- Reference month: stored as `vf_ref_month`

Only some pages fully honor these filters. Inventory has its own deeper hash-linked drilldown. Analytics has partial `region` and `bu` support only for SKU Matrix.

### Proposed global filter spine

Create one global `HQ_FILTER` state:

```js
{
  period: 'MTD',
  compare: 'vs_py',
  unit: 'MT',
  ref_month: '2026-05',
  region: 'ALL',
  region_basis: 'shipping',
  segment: 'ALL',
  bu: 'ALL',
  brand: null,
  product_family: null,
  district: null,
  dsm: null,
  rsm: null,
  customer: null,
  plant: null,
  scope: null
}
```

Each page and panel should declare which filters it supports. Unsupported filters should be shown as disabled or ignored with a `meta.unsupported_filters` note from the API.

### URL deep links

Use the Inventory pattern as the base and generalize it:

```text
#pg-sales?period=MTD&compare=vs_py&unit=MT&region=Visayas&segment=KA&brand=VIEPRO_PREMIUM
#pg-speed?period=7D&region=Mindanao&segment=DIST&district=Central%20Mindanao
#pg-custdetail?customer=C12345&return=pg-sales&period=MTD&region=Visayas
```

This gives users Looker-style behavior: select Visayas once, and the relevant panels respond together.

### Cross-filter interactions

| User action | Expected behavior |
| --- | --- |
| Click region row | Set global region filter and refresh visible panels. |
| Click brand row | Set brand/product family filter and update customer, district, sales, and speed panels. |
| Click customer | Open Customer Detail with return context preserved. |
| Click plant | Filter inventory and speed to plant; offer link to shipping region. |
| Click aging bucket | Open AR client list filtered to that bucket. |
| Click RSM/DSM | Filter sales, speed, budget, and customers by owner if mapping exists. |
| Click budget gap | Open action cockpit filtered to the drivers of the gap. |

Add filter chips under the topbar:

```text
Viewing: MTD | vs PY | MT | Visayas | Key Accounts | VIEPRO PREMIUM
Clear: Region | Segment | Brand | All
```

## Standard API Panel Contract

Every chart/table endpoint should return `meta` and source flags. This removes ambiguity when a page mixes real and proxy data.

```json
{
  "meta": {
    "applied_filters": {
      "period": "MTD",
      "compare": "vs_py",
      "unit": "MT",
      "region": "Visayas",
      "segment": "KA"
    },
    "period_window": {
      "from": "2026-05-01",
      "to": "2026-05-19",
      "shipping_days_elapsed": 15,
      "shipping_days_total": 26,
      "remaining_shipping_days": 11
    },
    "source": {
      "volume": "ODLN",
      "sales": "OINV",
      "gross_margin": "OINV",
      "budget": "FY2026_OFFICIAL_V1"
    },
    "data_quality": {
      "contains_proxy": false,
      "proxy_fields": [],
      "notes": []
    },
    "generated_at": "2026-05-19T03:30:00Z"
  },
  "summary": [],
  "rows": [],
  "links": {},
  "pagination": {
    "next_cursor": null
  }
}
```

Use badges in the UI:

- `DR volume`
- `Invoice sales`
- `Official budget`
- `Allocated budget`
- `Proxy`
- `Mapping pending`

## Streamlining Heavy Windows

The app should move from page-level heavy loading to panel-level loading.

### Loading tiers

| Tier | What loads first | Examples |
| --- | --- | --- |
| Tier 1 | Scorecards and top 5 risks/opportunities | Home, EVP, Sales, Speed, AR, Budget |
| Tier 2 | Top 10 tables and monthly charts | Sales trend, AR aging, regional split, brand split |
| Tier 3 | Full detail tables | Pending PO lines, customer lists, SKU matrices, itemized matrix |
| Tier 4 | Exports and advanced analytics | Itemized export, whitespace, buying patterns, brand coverage |

### Implementation rules

1. First paint should not wait for every detail table.
2. Each table with more than 50 rows should support server-side paging or cursor loading.
3. Deeper analytics should load only when its tab/section is opened.
4. Expandable boxes should fetch their own detail endpoint.
5. Use request tokens or `AbortController` so stale responses do not overwrite newer filtered results.
6. Cache keys must include all applied filters.
7. Empty states must say whether the filter produced no rows or the data mapping is not available.

## Page-By-Page Audit

### Home

Current behavior: `loadHome()` fetches dashboard, sales, AR, and speed in parallel. This gives a rich page but makes the first view heavy and mixes several endpoint contracts.

Make smarter:

- Keep the original dashboard look.
- Reduce top cards to the few highest-signal metrics: shipped volume, budget pace, speed projection, sales, GM/T, AR/DSO risk.
- Region rows should be clickable and set global region filter.
- Monthly/quarterly charts should honor global period, region, segment, and unit where relevant.
- Use Speed endpoint for speed/projection, not local approximations.

Stream:

- Load scorecards first.
- Load monthly trend and top customer panels after first paint.
- Load AR risk and pending billing only if the section is visible or expanded.

### CEO/EVP Sales Command

Current behavior: A prototype exists, but it should not replace HQ.

Make smarter:

- Make it a high-level weekly/monthly scorecard for CEO and EVP.
- Focus on sales execution, not P&L.
- Show Distribution and Key Accounts separately.
- Include volume vs budget, speed/trend, top gap regions, top recoverable customers, and next actions.
- Use real endpoint data only. Prototype constants should be removed or labeled as sample.

Stream:

- One summary endpoint for scorecards.
- Expandable action cockpit for region, DSM, customer, brand, and pending PO detail.

### Sales

Current behavior: Sales uses OINV for many metrics and loads pending PO details with TOP 200 lines and TOP 500 headers.

Make smarter:

- Add monthly volume chart similar to the daily Looker Studio view.
- Add speed/projection overlay: average shipped per day multiplied by period shipping days.
- Add global segment filter: Distribution vs Key Accounts.
- Make brand, customer, district, and segment rows clickable.
- Clearly label invoice volume vs DR shipped volume.

Stream:

- Show top 10 customers/brands first.
- Move pending PO detail behind an expandable box.
- Add pagination for PO line detail.

### AR

Current behavior: AR returns a large client payload and the frontend filters/sorts/caps locally.

Make smarter:

- Aging buckets should be clickable.
- Every customer should link to Customer Detail and SOA.
- DSO should state its date window and source.
- Add region/segment/customer-owner filters.

Stream:

- Server-side pagination for clients.
- Load SOA only when a customer is opened.

### Inventory

Current behavior: Inventory already has local region/plant drilldown and URL hash syncing.

Make smarter:

- Keep this interaction model and turn it into the HQ-wide filter pattern.
- Add links from plant/region inventory into Speed and Sales filtered to the same region/plant where possible.
- Label inventory region as plant/shipping region.

Stream:

- Keep summary and plant rows first.
- Lazy-load item-level detail and negative stock detail.

### Speed

Current behavior: Speed is the closest to the user's Looker Studio pullout logic. It uses ODLN and shipping-day calendar helpers.

Make smarter:

- Treat Speed as the canonical source for shipped volume, daily pullout, and projected period volume.
- Add monthly chart for shipped volume vs prior year and budget.
- Add filters for region, segment, BU, district, brand, and plant where source mapping is reliable.
- Show expected volume calculation directly: average shipped per day times shipping days in selected period.

Stream:

- Load national scorecards first.
- Lazy-load weekly, daily, RSM, plant, brand, and district tables.

### Customers

Current behavior: Customers already has server-side pagination, search, region, sort, and limit.

Make smarter:

- Add Key Accounts vs Distribution segmentation.
- Add filter chips from global state.
- Add customer health badges from AR, speed, and buying patterns.
- Preserve return context when opening Customer Detail.

Stream:

- Keep current server pagination.
- Fetch customer health details only for visible rows.

### Customer Detail

Current behavior: Customer profile loads a broad 360 view.

Make smarter:

- Open from any customer link with the same global context preserved.
- Show source badges for sales, volume, AR, product history, and SOA.
- Add tabs: Summary, AR/SOA, Products, Monthly Trend, Orders.

Stream:

- Load summary first.
- Lazy-load AR/SOA, product history, and recent orders.

### Margin

Current behavior: Margin endpoint returns many dimensions at once, including customer, SKU, plant, sales group, BU, and worst SKUs.

Make smarter:

- Keep it as a margin risk/guardrail page.
- Clearly distinguish true margin data from weak BU/customer-name proxies.
- Add clickable low-margin customer and SKU links.
- Add filter support for region, segment, brand, and period.

Stream:

- Load scorecards and top risk table first.
- Lazy-load secondary dimension tables.

### Insights

Current behavior: Insights loads core intelligence, then automatically triggers deeper analytics: SKU Matrix, Brand Coverage, and Buying Patterns.

Make smarter:

- Keep hero insights fast: rescue, growth, early warning.
- Add region and segment filters to all deeper analytics, not only SKU Matrix.
- Separate Key Accounts and Distribution insight narratives.
- Show opportunity estimates as estimates, not fact.

Stream:

- Do not auto-load deeper analytics on initial page load.
- Load each deep tab only when opened.
- Paginate buying-pattern customers.

### Team

Current behavior: Team has national, RSM, and DSM rollups. National target exists, but RSM/DSM target fields are zero because real RSM-level budgets are not in SAP.

Make smarter:

- Do not show 0 percent target achievement as if it is real.
- Add clear target badges: official, allocated, or missing.
- Use RSM/DSM click actions to filter Sales, Speed, Customers, and Budget if ownership mapping is reliable.
- Make hierarchy source clear: OSLP, RSM field, manager/subordinate mapping.

Stream:

- Load EVP/RSM summary first.
- Expand DSM detail only when an RSM is opened.

### Budget

Current behavior: Budget is the strongest budget source, but it uses OINV actuals and pacing logic that may not match Speed/Home volume logic.

Make smarter:

- Centralize budget values here and export them through a helper.
- Separate sales budget scorecard from P&L budget analysis.
- Use ODLN for shipped volume actuals where comparing to volume budget.
- Make budget rows clickable into Sales and Speed action detail.

Stream:

- Load summary and region budget first.
- Lazy-load P&L and monthly detail if this page stays broad.

### Itemized

Current behavior: Total National pulls real SAP data. Other district selections return structure with zero values and `district_mapping_pending`.

Make smarter:

- Keep it as a product deep-dive, not a headline dashboard.
- Make district mapping pending highly visible.
- Add links from product groups/SKUs to Sales, Customers, and Margin.

Stream:

- Load national summary first.
- Load product group/SKU detail on expand.
- Keep export as an explicit user action.

## Endpoint And Chart Data Contract Audit

| Area | Current issue | Recommendation |
| --- | --- | --- |
| Period helper | `_auth.getPeriodDates('7D')` and `shipping_days.getPeriodBounds('7D')` disagree. | One shared period helper for all endpoints. |
| Budget | Multiple hardcoded budget constants. | One official budget module consumed by Dashboard, Speed, Team, Budget, and EVP. |
| Volume | ODLN and OINV are mixed by page. | ODLN for shipped volume; OINV for sales/GM. Return both only when useful. |
| Region | Warehouse region often used silently. | Add `region_basis` metadata. |
| Segment | KA/DIST/PET logic is partial and duplicated. | Shared business segmentation helper. |
| Role scope | Role filter scaffold exists, but broad roles return full data. | Decide whether HQ is exec-only or role-scoped; enforce consistently. |
| Sales pending PO | Detail rows and proxy line value are loaded early. | Summary first, expandable paginated detail, proxy badge. |
| AR clients | Full list loaded, frontend filters. | Server pagination/search/filter. |
| Insights | Deep analytics auto-load. | Lazy-load deep analytics by tab and filter all panels. |
| Team targets | RSM/DSM targets missing. | Official or allocated budget source, otherwise hide achievement. |
| Itemized district | Non-national district views are mapping-pending. | Strong UI badge and do not use for decisions until mapped. |

## Recommended Roadmap

### P0 - Data truth and filter spine

1. Create shared period helper and fix 7D.
2. Create shared budget helper from the official FY2026 budget source.
3. Create shared business segmentation helper for Distribution, Key Accounts, Pet Care, and other required segments.
4. Add `meta.applied_filters`, `meta.source`, and `meta.data_quality` to every endpoint.
5. Build shared frontend `HQ_FILTER` state and URL deep-link parser.
6. Add panel-level request keys or `AbortController` to prevent stale filter responses.

### P1 - Smart dashboard interactions

1. Generalize Inventory's hash/filter pattern to every page.
2. Make region, brand, customer, plant, RSM, DSM, and budget-gap rows clickable.
3. Add global filter chips with clear/remove actions.
4. Convert heavy detail tables to expandable panels.
5. Add server-side pagination to AR, pending PO, and deeper analytics detail tables.
6. Add monthly volume/speed/budget charts to Sales and CEO/EVP Sales Command.

### P2 - Action cockpit and assistant

1. Add a weekly/monthly action cockpit with gap drivers and owners.
2. Add deterministic drilldown prompts, for example:
   - Why is Visayas below budget?
   - Which DSMs are behind speed pace?
   - Which KA customers slowed down in May?
   - Which products are driving GM/T decline?
3. The assistant should answer only from panel data contracts and always cite filters, period, source, and proxy flags.

## Open Questions

1. What is the official source of Key Accounts: SlpCode list, customer master list, SAP group, or a maintained Excel/SharePoint file?
2. What is the official DSM/district budget source?
3. Should all volume budget comparisons use ODLN delivered volume?
4. Should region mean shipping region, customer region, sales ownership region, or budget region in each page?
5. Should budget pacing use shipping days or calendar days?
6. For a past reference month, should MTD mean full month or equivalent day-of-month cut-off?
7. Which pages must honor 7D/MTD/QTD/YTD, and which should stay trailing-12-month analysis?
8. Should HQ role access remain full-scope, or should RSM/DSM users see only their scope?
9. What first-load target should we design for: 1.5 seconds for scorecards, 3 seconds for top panels?
10. Should P&L stay separated from the CEO/EVP Sales dashboard?
11. Are plant/warehouse region and sales territory allowed to be shown side-by-side, or should one become the default?
12. Which action cockpit owner level is most useful: RSM, DSM, district, TSR, or customer?

## Code References

- Topbar API params: `app.html:3931`
- Period setter and cache clear: `app.html:4256`
- Home heavy parallel load: `app.html:4360`
- Sales load: `app.html:4628`
- Inventory local drill state: `app.html:4968`
- Inventory product filter honoring region/plant: `app.html:5131`
- Speed load using topbar params: `app.html:5178`
- Margin load: `app.html:5657`
- Insights load: `app.html:6048`
- Deeper analytics auto-load: `app.html:6203`
- Deeper analytics loader: `app.html:6242`
- Team load: `app.html:6568`
- Budget load: `app.html:6734`
- Inventory hash sync: `app.html:8449`
- Current period helper: `api/_auth.js:59`
- Current 7D issue: `api/_auth.js:68`
- Role filter TODO: `api/_auth.js:79`
- Shipping-days period helper: `api/lib/shipping_days.js:95`
- Dashboard budget constant: `api/dashboard.js:7`
- Dashboard ODLN/OINV source comment: `api/dashboard.js:63`
- Dashboard monthly OINV and ODLN queries: `api/dashboard.js:337`, `api/dashboard.js:352`
- Sales monthly query: `api/sales.js:109`
- Sales pending PO detail limits: `api/sales.js:135`, `api/sales.js:155`
- Speed budget constant and period target: `api/speed.js:68`, `api/speed.js:85`
- Budget official-looking source: `api/budget.js:7`
- Team budget constant and missing RSM targets: `api/team.js:27`, `api/team.js:616`
- Itemized mapping pending: `api/itemized.js:104`, `api/itemized.js:269`
- Customers pagination: `api/customers.js:19`, `api/customers.js:154`
- SKU Matrix KA/BU filtering: `api/analytics-sku-matrix.js:35`, `api/analytics-sku-matrix.js:144`
- Brand Coverage cache lacks query filters: `api/analytics-brand-coverage.js:50`
- Buying Patterns cache lacks query filters: `api/analytics-buying-patterns.js:43`
