# EVP Sales Dashboard Data-Contract Audit

Date: 2026-05-19

Scope: focused audit before implementing the new EVP Sales and Marketing dashboard.

## Executive Summary

The new EVP dashboard should not be built directly on the current UI data mix yet. The current code has enough real SAP data to build a much stronger Sales and Marketing cockpit, but the contract needs cleanup first.

Critical findings:

1. There is no reliable DSM/district budget source in the current app. DSM actuals exist, but DSM and RSM targets are either zero, placeholder, or proxy.
2. Period windows are inconsistent. The same `7D` filter can mean 7 inclusive days in `/api/speed`, but effectively 8 inclusive days in endpoints using `_auth.getPeriodDates`.
3. Budget constants are duplicated and inconsistent across endpoints. `/api/budget` uses the Excel monthly phasing, while `/api/dashboard`, `/api/team`, and `/api/speed` use quarter-even monthly phasing.
4. "Volume" is not consistently sourced. Some endpoints use ODLN delivery notes as the volume of record, while others use OINV invoiced volume.
5. Current EVP UI mixes real data, finance/P&L concepts, 2033 strategic target logic, hardcoded opportunity cards, and region target proxies. It should be replaced by a focused endpoint with explicit data provenance.

Recommendation: implement one new EVP endpoint, backed by shared period and budget helpers, instead of composing the new page from existing dashboard endpoints as-is.

## Current Filters To Preserve

The new page should preserve these controls:

- Period: `7D`, `MTD`, `QTD`, `YTD`
- Compare: `vs PP`, `vs PY`, `vs Budget`
- Unit: `MT`, `Bags`
- Reference month: `live` or `YYYY-MM`
- Optional custom review window for a particular month or selected date range
- Organization grain: National -> Region -> DSM/District

Recommended query shape:

```http
GET /api/evp/sales-scorecard?period=MTD&compare=vs_py&unit=MT&ref_month=2026-05
```

Optional filters:

```http
GET /api/evp/sales-scorecard?period=MTD&compare=vs_budget&unit=BAGS&ref_month=2026-05&region=Visayas
GET /api/evp/sales-scorecard?period=CUSTOM&from=2026-05-01&to=2026-05-15&compare=vs_pp&unit=MT
```

## Period Audit

### Existing Code Paths

Current period handling is split:

- `api/_auth.js` exports `getPeriodDates(period, opts)`.
- `api/lib/shipping_days.js` exports `getPeriodBounds(period, today)`.

Key difference:

- `_auth.getPeriodDates('7D')` starts at `anchor day - 7`.
- `shipping_days.getPeriodBounds('7D')` starts at `anchor day - 6`.

Because SQL uses inclusive `BETWEEN`, the first path can count 8 calendar dates, while the speed path counts 7 calendar dates.

Endpoints using `_auth.getPeriodDates`:

- `/api/dashboard`
- `/api/sales`
- `/api/budget`
- `/api/team`
- `/api/margin`
- `/api/dsm/home`

Endpoint using `shipping_days.getPeriodBounds`:

- `/api/speed`

### Previous Period Audit

Previous-period logic also differs:

- `/api/sales` and `/api/team` use same-length previous window ending the day before the selected period starts.
- `/api/dashboard` uses the full previous calendar month through `monthRange(year, monthIdx - 1)`, regardless of whether the selected period is `7D`, `MTD`, `QTD`, or `YTD`.

This means a dashboard `vs PP` can compare MTD to the whole previous month, while team/sales compare to a same-length window.

### Required Standard

Create one shared helper:

```js
resolvePeriodWindow({
  period: '7D' | 'MTD' | 'QTD' | 'YTD' | 'CUSTOM',
  ref_month: 'YYYY-MM' | null,
  from: 'YYYY-MM-DD' | null,
  to: 'YYYY-MM-DD' | null,
  timezone: 'Asia/Manila'
})
```

It should return:

```js
{
  anchor_date,
  current: { from, to, label, calendar_days, shipping_days },
  previous: { from, to, label },
  prior_year: { from, to, label },
  budget_period: { from, to, pacing_basis }
}
```

Recommended semantics:

- `7D`: inclusive rolling 7 days, anchor day minus 6 through anchor day.
- `MTD`: first day of anchor month through anchor day.
- `QTD`: first day of anchor quarter through anchor day.
- `YTD`: Jan 1 through anchor day.
- `CUSTOM`: explicit `from` and `to`.
- `vs PP`: same-length prior window by default, not full previous calendar month.
- `vs PY`: same calendar date range shifted back one year.
- Budget pacing: based on the selected period window, with shipping-day awareness.

## Budget Audit

### Budget Exists, But Not As A Single Source

Budget figures are visible in the current HQ desktop, but they are not centralized.

`api/budget.js` has the most detailed budget source:

- FY target MT: `188,266`
- FY target sales: `5,975,000,000`
- FY target GM: `1,233,000,000`
- Monthly MT phasing: `[14010, 12999, 14791, 15334, 15536, 15005, 16735, 16247, 17097, 18391, 17211, 16981]`
- Region FY budgets:
  - Visayas: `76,271`
  - Mindanao: `65,110`
  - Luzon: `46,886`

Other endpoints define separate budget constants:

- `api/dashboard.js`: annual target matches, monthly phasing is quarter-even.
- `api/team.js`: annual target matches, monthly phasing is quarter-even and YTD is day-prorated.
- `api/speed.js`: annual and quarterly targets match its own constants, monthly phasing is quarter-even.

This creates avoidable disagreement between pages.

### Region Budget Source

`/api/budget` has region-level budgets from hardcoded FY2026 constants. Region actuals are calculated from warehouse code mapping:

- `AC`, `ACEXT`, `BAC` -> Luzon
- `HOREB`, `ARGAO`, `ALAE` -> Visayas
- `BUKID`, `CCPC` -> Mindanao
- else -> Other

This is useful for a first region layer, but it is not the same as DSM/district ownership.

### DSM/District Budget Source

No official DSM/district budget table or file was found in the audited code.

Evidence:

- `/api/team` discovers DSMs from `OSLP.U_rsm` hierarchy and computes actuals, but returns DSM `ytd_target: 0` and `ach_pct: 0`.
- `/api/team` returns RSM `ytd_target: 0` and comments that real RSM-level budgets are not in SAP.
- `/api/dsm/home` target is calculated as `110%` of prior period revenue, explicitly noted as a v1 proxy until DSM budgets are uploaded.
- `app.html` contains static RSM target rows and a note saying targets are placeholder and need actual RSM/DSM budgets.
- `/api/itemized` has district lists and district managers, but non-national districts return zero data with `district_mapping_pending`.
- `/api/_scope` resolves `sap_slpcode`, `sap_district_code`, and `district_label`, but it is an access/scope helper, not a budget source.

### Required Budget Model

Create a single shared source before building the EVP page:

```text
api/lib/budget_2026.js
```

or, preferably, a database-backed table:

```text
sales_budget
```

Minimum fields:

```text
fiscal_year
month
region
rsm_slpcode
rsm_name
dsm_slpcode
dsm_name
district_code
district_label
budget_mt
budget_bags
budget_net_sales
budget_source
budget_version
is_allocated_proxy
```

If official DSM budgets are not available immediately, use a temporary allocated budget only if it is visibly labeled:

```text
budget_source: "allocated_proxy_from_region_budget"
is_allocated_proxy: true
```

Do not display allocated DSM targets as official.

## Real Vs Proxy Metric Classification

### Real Or Mostly Real

These are usable in the new contract if the source and caveats are stated:

| Metric | Current source | Audit note |
| --- | --- | --- |
| National shipped volume | ODLN/DLN1 in `/api/dashboard`, `/api/team`, `/api/speed` | Best candidate for volume of record. |
| Net sales | OINV/INV1 | Real invoiced revenue. Good for Sales dashboard. |
| Invoiced volume | OINV/INV1 | Real, but not the same as shipped volume. Keep as secondary transparency metric. |
| Region actual volume | ODLN in `/api/dashboard`, OINV in `/api/budget` | Real transaction data, but region is warehouse-derived. |
| RSM/DSM actuals | `/api/team` via OSLP hierarchy | Useful, but some RSM/DSM volume fields are OINV while EVP total is ODLN. Standardize before use. |
| Pending PO | ORDR/RDR1 in `/api/sales` and `/api/dashboard` | Real open order data. Good for action cockpit. |
| Customer ranking | OINV/ODLN depending on endpoint | Real, but choose one endpoint/source per card. |
| Customer intelligence | `/api/intelligence` | Derived from real SAP history, with explainable scoring. |
| AR/DSO | `/api/ar` | Real finance/AR data. Use only as optional commercial guardrail, not P&L headline. |

### Proxy, Placeholder, Or Not Fit For EVP Contract

These should not power the new EVP dashboard unless explicitly labeled:

| Metric | Current location | Issue |
| --- | --- | --- |
| DSM/RSM targets in `/api/team` | `ytd_target: 0`, `ach_pct: 0` | Missing official target source. |
| DSM mobile target | `/api/dsm/home` | 110% of prior period revenue, not budget. |
| RSM mobile conversions | `js/rsm-home.js` | 10% proxy from active minus silent customers. |
| RSM mobile district achievement | `js/rsm-home.js` | Deterministic pseudo percentage from district name. |
| RSM mobile DSM score, MTD, trend | `js/rsm-home.js` | Generated from name length. |
| RSM whitespace | `js/rsm-home.js` | Synthetic count and value estimate. |
| EVP 2033 target progress | `js/evp-home.js` | Strategic long-term target, not weekly/monthly operating budget. |
| EVP region achievement | `js/evp-home.js` | Uses hardcoded weights, not official region budget. |
| EVP opportunities | `js/evp-home.js` | Static hardcoded opportunity cards. |
| Budget page chart defaults | `app.html` chart initialization | Static fallback data before `/api/budget` renders. |

## Existing Endpoint Inventory

Use this as the source map when building the new endpoint.

| Endpoint | Useful fields | Main issue for EVP |
| --- | --- | --- |
| `/api/dashboard` | `volume_mt`, `volume_bags`, `revenue`, `delta_pct`, `delta_pct_ly`, `ytd`, `budget`, `region_performance`, `pending_po`, `top_customers` | Good national/region source, but period and PP logic need standardization. Region actuals are warehouse-derived. |
| `/api/sales` | `kpis`, `by_brand`, `top_customers`, `monthly_trend`, `pending_po`, optional `whitespace`, optional `at_risk` | Uses OINV for sales volume metrics. Good for sales details and pending PO, not the volume-of-record headline. |
| `/api/team` | `evp`, `rsms`, nested `dsms`, `performance_matrix`, `account_health`, `meta` | Strong hierarchy source, but RSM/DSM budgets are missing and some rollups use OINV while EVP total uses ODLN. |
| `/api/budget` | `hero`, `achievement_by_region`, `budgeted_volume`, `monthly_actual_vs_budget` | Best budget detail, but it is P&L-oriented and uses its own budget constants. Region actuals use OINV and warehouse mapping. |
| `/api/speed` | `actual_mt`, `projected_mt`, `target_mt`, shipping-day context, daily/weekly/monthly breakdown | Uses ODLN and good shipping-day logic, but budget constants differ from `/api/budget`. |
| `/api/intelligence` | `hero_stats`, `top_rescue`, `top_growth`, `early_warning`, `dormant_active`, `legacy_ar`, `meta` | Good action cockpit source. Scores are derived, so label as rule-based recommendations. |
| `/api/customers` | customer list with YTD revenue, bags, volume, region, status, vs LY | Good drilldown source, but region is dominant warehouse-derived and customer ownership needs alignment with DSM scope. |
| `/api/ar` | DSO, active balance, account status, aging buckets, clients | Optional guardrail only. Keep out of main EVP summary if the page must stay Sales/Marketing. |
| `/api/margin` | low-margin customers, by region/brand/plant | Optional commercial guardrail only. Avoid P&L headline cards. |
| `/api/itemized` | national product hierarchy and totals | District mode is not production-ready because non-national districts return `district_mapping_pending`. |

Conclusion: the EVP page should not call all of these endpoints directly from the browser. It should call one purpose-built backend endpoint that applies one period model, one budget model, and one source-of-truth rule per metric.

## Proposed EVP Endpoint Contract

Endpoint:

```http
GET /api/evp/sales-scorecard
```

Purpose: one clean contract for the EVP Sales and Marketing dashboard. No COGS, P&L table, or gross-margin financial statement view.

### Request

```text
period=7D|MTD|QTD|YTD|CUSTOM
compare=vs_pp|vs_py|vs_budget
unit=MT|BAGS
ref_month=YYYY-MM optional
from=YYYY-MM-DD optional for CUSTOM
to=YYYY-MM-DD optional for CUSTOM
region=ALL|Luzon|Visayas|Mindanao optional
grain=national|region|dsm optional
include=actions,regions,districts,customers,assistant_context optional
```

### Response Shape

```json
{
  "meta": {
    "generated_at": "2026-05-19T10:00:00.000Z",
    "timezone": "Asia/Manila",
    "period": "MTD",
    "compare": "vs_py",
    "unit": "MT",
    "ref_month": "2026-05",
    "anchor_date": "2026-05-19",
    "current_window": {
      "from": "2026-05-01",
      "to": "2026-05-19",
      "calendar_days": 19,
      "shipping_days": 16
    },
    "previous_window": {
      "from": "2026-04-12",
      "to": "2026-04-30"
    },
    "prior_year_window": {
      "from": "2025-05-01",
      "to": "2025-05-19"
    },
    "budget_version": "FY2026_OFFICIAL_V1",
    "volume_source": "ODLN",
    "sales_source": "OINV",
    "hierarchy_source": "OSLP.U_rsm",
    "budget_source": "sales_budget",
    "contains_proxy": false
  },
  "summary_cards": {
    "volume": {
      "actual_mt": 14200.4,
      "actual_bags": 1420040,
      "budget_mt": 15334,
      "achievement_pct": 92.6,
      "gap_mt": -1133.6,
      "compare_pct": 8.4,
      "status": "watch"
    },
    "net_sales": {
      "actual_php": 482000000,
      "budget_php": 515000000,
      "achievement_pct": 93.6,
      "gap_php": -33000000,
      "compare_pct": 6.2,
      "status": "watch"
    },
    "customer_momentum": {
      "active_customers": 545,
      "new_customers": 18,
      "reactivated_customers": 12,
      "declining_customers": 32,
      "silent_customers": 27,
      "status": "watch"
    },
    "field_execution": {
      "dsm_total": 24,
      "dsm_on_track": 14,
      "dsm_below_90": 7,
      "dsm_below_80": 3,
      "status": "action"
    }
  },
  "action_cockpit": [
    {
      "id": "visayas-gap",
      "severity": "high",
      "type": "budget_gap",
      "title": "Visayas is 1,050 MT below MTD budget",
      "owner_level": "RSM",
      "region": "Visayas",
      "impact_mt": 1050,
      "impact_php": 33300000,
      "recommended_action": "Open Visayas DSM drilldown and focus on bottom 3 DSM gaps.",
      "drilldown_ref": "region:Visayas"
    }
  ],
  "regions": [
    {
      "region": "Visayas",
      "actual_mt": 5100.2,
      "budget_mt": 6150.0,
      "achievement_pct": 82.9,
      "gap_mt": -1049.8,
      "actual_php": 162000000,
      "budget_php": 195000000,
      "compare_pct": -4.1,
      "dsm_total": 8,
      "dsm_on_track": 3,
      "top_issue": "Two DSMs below 80% of paced budget",
      "top_opportunity": "Open PO cover can recover 420 MT"
    }
  ],
  "districts": [
    {
      "region": "Visayas",
      "rsm_slpcode": 101,
      "rsm_name": "RSM Name",
      "dsm_slpcode": 245,
      "dsm_name": "DSM Name",
      "district_code": "VIS-CEB",
      "district_label": "Cebu",
      "actual_mt": 720.4,
      "actual_bags": 72040,
      "budget_mt": 900.0,
      "budget_bags": 90000,
      "achievement_pct": 80.0,
      "gap_mt": -179.6,
      "actual_php": 22860000,
      "budget_php": 28560000,
      "compare_pct": -8.5,
      "active_customers": 42,
      "declining_customers": 6,
      "silent_customers": 3,
      "open_po_mt": 120.2,
      "issue_tags": ["below_budget", "customer_decline"],
      "budget_source": "official",
      "data_quality": {
        "actuals": "real",
        "budget": "official",
        "hierarchy": "real"
      }
    }
  ],
  "drilldowns": {
    "customer_movement": {
      "decliners": [],
      "reactivations": [],
      "new_customers": [],
      "silent_customers": []
    },
    "brand_coverage": {
      "underpenetrated_brands": [],
      "targetable_customers": []
    },
    "pending_orders": {
      "top_customers": [],
      "aging_buckets": []
    }
  },
  "assistant_context": {
    "enabled": true,
    "safe_questions": [
      "Why is Visayas below MTD budget?",
      "Which DSMs can recover the May gap fastest?",
      "Show customers declining versus prior year in Mindanao.",
      "What open POs can convert this week?"
    ],
    "allowed_sources": [
      "summary_cards",
      "regions",
      "districts",
      "drilldowns"
    ]
  }
}
```

## Recommended Summary Cards

Keep the first screen to four cards only:

1. Volume vs Budget
2. Net Sales vs Budget
3. DSM/District Execution
4. Customer Momentum

Avoid P&L cards in this EVP view. Gross margin, COGS, and full P&L should stay on Finance/Budget pages. If margin is needed, use it only as an action cockpit guardrail like "customers below commercial floor", not as a headline card.

## Recommended Action Cockpit

The action cockpit should be the second major section, directly under summary cards.

Rank actions by:

1. Budget recovery impact
2. Probability of recovery this period
3. Customer/account urgency
4. DSM/RSM ownership clarity

Action types:

- Budget gap
- DSM below threshold
- Open PO conversion
- Customer decline
- Silent high-value account
- New/reactivated customer momentum
- Brand coverage opportunity

Each action must have:

- Severity
- Owner level
- Region
- DSM/district when available
- MT impact
- PHP impact where relevant
- Recommended next step
- Drilldown reference
- Source fields used

## Implementation Sequence

### Step 1: Create Shared Period Helper

Create or refactor into:

```text
api/lib/periods.js
```

Replace period math in `_auth.js`, `shipping_days.js`, `/api/dashboard`, `/api/sales`, `/api/team`, `/api/budget`, and `/api/speed` over time.

For the first EVP endpoint, use the new helper immediately and avoid old mixed semantics.

### Step 2: Create Shared Budget Helper

Create:

```text
api/lib/budget_2026.js
```

Move the official budget constants out of endpoint files. The helper should expose:

```js
getBudgetForPeriod({ periodWindow, unit, scope })
getRegionBudget({ region, periodWindow, unit })
getDsmBudget({ dsm_slpcode, district_code, periodWindow, unit })
getBudgetMetadata()
```

### Step 3: Add DSM/District Budget Source

Preferred: upload official DSM/district budgets to a database table.

Fallback: allocate region budgets to DSMs using a chosen basis, but mark as proxy. Acceptable allocation bases:

- last-year same-period actual mix
- trailing 90-day shipped volume mix
- management-entered DSM share

Do not use allocated budgets silently.

### Step 4: Build `/api/evp/sales-scorecard`

The endpoint should query or reuse shared services for:

- ODLN shipped volume
- OINV net sales
- ORDR pending orders
- OSLP hierarchy
- official budget helper
- customer movement or intelligence helper

Avoid pulling raw current UI endpoints as the main source, because their definitions differ.

### Step 5: Build Expandable UI

First viewport:

- filter bar
- four summary cards
- action cockpit
- region scorecard strip

Expandable sections:

- DSM/district table
- customer movement
- pending orders
- brand coverage
- "Ask VieForce" drilldown panel

## Open Questions For Decision

1. Do official DSM/district budgets exist outside this repo, for example in Excel, SharePoint, SAP UDFs, or a planning file?
2. Are DSM budgets monthly, quarterly, annual only, or all three?
3. Should DSM budget be owned by DSM person, district code, customer territory, or region/district assignment?
4. If a customer changes DSM mid-year, should actuals follow current owner, historical owner, or transaction owner?
5. Should the official volume of record for EVP be ODLN shipped volume in all cases?
6. Should Net Sales budget be official, or derived from MT budget times budgeted net sales per ton?
7. For `vs PP`, should MTD compare to the same number of days in the prior month, or the immediately preceding same-length window?
8. For `ref_month` in a closed month, should MTD mean full month or same day-of-month as today?
9. Is `Bags` conversion always `Quantity`, while `MT` is `Quantity * NumInSale / 1000`, for every SKU?
10. Which commercial guardrails are acceptable in the EVP Sales page without making it a P&L dashboard?
11. Should Ask VieForce answer only from the precomputed endpoint payload, or can it call drilldown endpoints live?
12. What are the red/yellow/green thresholds for weekly/monthly budget achievement?

## Go/No-Go For UI Implementation

Go for UI shell/prototype:

- Yes. The layout and interaction model can be implemented now with a mocked contract.

Go for production data wiring:

- Not yet. First fix the period helper and budget source, or the new dashboard will inherit contradictory numbers.

Minimum production-ready requirements:

- One period helper used by the EVP endpoint.
- One budget helper used by the EVP endpoint.
- Clear DSM/district budget source, even if marked as proxy.
- Every response metric carries source/proxy metadata.
- ODLN vs OINV volume definitions are explicit in `meta`.
