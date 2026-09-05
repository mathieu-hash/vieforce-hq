# Margin Explorer Preview

Built on `codex/margin-explorer-preview`, separately from the existing margin tab. No deployment or replacement has been performed.

## Entry points

- `margin-preview.html`: standalone page using the HQ session and API client. A separate sidebar link opens it; the existing tab is untouched.
- `api/margin-preview.js`: read-only endpoint, mounted in `server.js`. Executive/service sessions only; field roles are denied until territory mappings are verified for this endpoint. The existing shared role helper is permissive and is deliberately not used to grant field access.
- `api/lib/margin_preview.js`: filter validation, monthly aggregation, fixed-date windows, canonical bridge adapter, additive customer/SKU contributors and pricing candidates.
- `tests/margin_preview.test.js`: business-math, selection, input-validation and access-control checks.

## Implemented

Eight exact-code dimensions: category, region, BU, invoice salesperson, customer, SKU, brand and dispatch warehouse. Group, expand into another dimension, focus, remove filters, Back and save/restore a local view. Twelve calendar-month columns, seven metrics, weighted totals, sortable history, search, optional shading, scoped CSV export. Cell detail opens invoice/credit evidence (latest 100 lines, bounded). Cross-tables are capped at 30 rows × 20 columns with disclosure.

The existing Bennet engine is reused without modifying it. Both reported and after-document-discount bases are supported. Price/cost/mix contributors reconcile on the fixed selection denominator. Combined mix is shown when the customer/product split is unstable. Non-positive-volume cell exclusions are disclosed. National contribution is available for customer/SKU filters only; other dimensions may split a cell and are not allocated speculatively.

Pricing Opportunities currently detects material same-SKU/region/BU peer gaps and unrecovered cost drift. Candidate quantities use the full base month; peers use the same observation month as the target. Customer filters do not erase peer evidence. Signed credits remain in aggregates. One candidate per customer/SKU, no summed portfolio claim. Scenario assumptions explicitly cover price adjustment, volume loss and proportional document discount; company impact uses fixed national base tons.

## Boundaries

The preview is finished feed 103, with credit memos netted in production SQL. Existing broader hero scope and canonical bridge behaviour are unchanged. After-document-discount margin excludes GL rebates, freight and tolling. No new target or concentrates exclusion is imposed.

Production history starts January 2026; older month cells remain unavailable. No unverified pre-consolidation customer/SKU mapping. DSM means invoice salesperson, not an inferred current team hierarchy. Warehouse means dispatch, not manufacturing origin. Custom formula equivalence, terms, contracts, discount policy and retention still require commercial validation. Recipe optimisation and a full ledger profitability bridge are later work.

## Verification and local review

The repository tests and existing canonical bridge assertions pass. Browser interactions were exercised with a local-only frozen-extract adapter: expansion, category/DSM focus, Back, cell/invoice detail, cross-table, scenario, export and mobile layout. This adapter lives outside the repository and is not deployed. Its Jan–May history is monthly, June–September has invoice detail, historical DSM attribution is unavailable before June, and returns are excluded because the frozen return file lacks the necessary discount detail. These fixture limitations are labelled on-screen. Production SQL does not use this adapter.

New production SQL has not run against SAP. Before publishing: validate the endpoint on the deployed read-only connection, reconcile August totals including credits, verify whole-document discount allocation and executive authentication, measure query latency, and check both month-window modes. Master pushes deploy the service and frontend; do not push this branch to master as part of local review.

## Design and build order

The approved direction is a separate review page centred on the monthly table and linked bridges, followed by evidence-led pricing opportunities. Work order: isolated endpoint/model; shared exact selection; table and drills; bridges and contributors; pricing scenarios; browser and regression checks. A standalone specification was delivered in the Codex task outputs before implementation. This document records the implemented scope, not approval to replace the existing page.

## Bridge component drills
Price and Cost now show matched customer/SKU before-and-after rates, tons, average shares and bar contributions. Customer Mix and Product Mix show customer/SKU shares, share changes, margins and standalone centred effects, plus an explicit shared-interaction adjustment to reconcile to the symmetric bridge bar. Top 15 rows plus Other reconcile before rounding. Clicking a row focuses its exact customer/SKU, preserving comparison dates. Split-instability warnings remain visible. Ten preview tests and all four browser component drills pass.


## Visual segment and raw-material drills
All eight dimensions have a centred share-effect view: signed bars, before/after volume-share markers, margin rates, top seven plus Other, show-all and exact-row focus. Each is an independent aggregation lens, not an additive bridge allocation. One-sided rows say new/absent in the window, not commercial acquisition/churn.

Cost has an on-demand RM diagnostic using base-month WOR1 issued quantities per completed FG kg and OINM monthly production issue values/quantities. Fixed base-month SKU/dispatch-warehouse sales weights translate ingredient price changes to selected-scope PHP/t. Production warehouse suffix -PD is normalized; transfer origin is not inferred. Direct RM and basemix are separate; basemix is not exploded. Three documented erroneous orders are excluded. Recipe, fully-priced-recipe and component-price coverage are displayed, with missing evidence listed. Ingredient clicks reveal SKU/plant details. This is a production-price sensitivity, not a decomposition of sold COGS; batch lag, recipe changes, packaging, yield and revaluation are not modelled.

Validation: 176 repository tests pass, including hand-calculated RM effects, denominator de-duplication, missing coverage and segment sum checks. Browser checks pass for all eight segment selectors, focus/Back and RM ingredient details, without page errors. Frozen August-to-September example has 89.3% recipe coverage and 26.8% fully priced recipes; covered direct RM price effect is about -370 PHP/t and basemix -37 PHP/t. These are partial-coverage estimates, not a forecast or confirmed invoice-cost attribution. Production queries remain unverified against live SAP.
