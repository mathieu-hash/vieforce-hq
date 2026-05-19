# VieForce HQ Dashboard 50x Improvement Handoff

Generated: 2026-05-19  
Scope: VieForce HQ desktop dashboard, with special focus on the EVP Sales & Marketing dashboard  
Status: Strategy and design handoff, not an implementation plan

## Executive Summary

VieForce HQ already has the hard part: real operational data, role-based dashboards, budget context, SAP-backed sales/AR/inventory/speed endpoints, customer intelligence, and export workflows. The opportunity is not to add more data. The opportunity is to make the dashboard more decisive.

The current app often answers: "What data do we have?"

The next version should answer:

- Are we on plan?
- What changed?
- Where is the gap?
- Who owns the action?
- What should we do next?
- Where can I drill deeper only when needed?

For EVP specifically, the dashboard should become a Sales & Marketing scorecard. It should not be a P&L dashboard. Remove finance/P&L framing from the EVP view and focus on commercial performance: volume, net sales, budget achievement, DSM/district performance, customer momentum, market coverage, field execution, and commercial guardrails.

## Current Findings

### What Is Strong Today

- The product is already full-featured: Home, Sales, AR, Inventory, Speed, Customers, Customer Detail, Margin Alerts, Customer Intelligence, Sales Team, Budget & P&L, Itemized Sales, EVP/RSM/DSM role homes, and Admin Team Hierarchy.
- The existing topbar filter model is valuable and should be kept:
  - 7D
  - MTD
  - QTD
  - YTD
  - vs PP
  - vs PY
  - MT / Bags
  - reference month / period review
- Budget data already exists in the desktop experience:
  - Budget & P&L has FY2026 budget, monthly budget, regional achievement, actual vs budget, and achievement %.
  - Home has YTD sales/volume/gross margin vs budget.
  - Sales Team has national EVP budget achievement and RSM scorecard placeholders.
- Customer Intelligence and Customer Detail are high-value foundations for action-oriented drilldown.
- The app has a good operational data backbone: SAP B1, Supabase auth, Cloud Run APIs, Chart.js UI, Excel/PDF export.

### What Holds It Back

- The dashboard shows too much data at once. Important signals compete with supporting detail.
- EVP currently mixes executive scorecard, P&L, long-term target, region cards, risk radar, opportunity radar, and top performers without a single hierarchy.
- Budget is present, but not central enough in EVP.
- Region-level summaries are useful but too coarse for action. The actionable layer is DSM/district.
- Some role-dashboard metrics are placeholders or proxies, especially RSM/DSM-level target achievement.
- Several pages show topbar filters even when the page says the filter does not apply.
- Some nav items are present but not implemented, such as Sales Pivot and Customer Plotting.
- The current design often gives "data tables" before it gives "management decisions."

## Core Product Principle

VieForce HQ should become a management operating system for Sales & Marketing.

Every page should have three levels:

1. Score: are we good or not?
2. Diagnosis: where is the issue or opportunity?
3. Action: who should do what next?

Tables, charts, and exports should be available, but should not be the first thing the user has to interpret.

## EVP Dashboard Redesign

### Positioning

Rename the EVP page from a generic executive overview to:

Sales & Marketing Scorecard

Subtitle:

Weekly and Monthly Commercial Health

No P&L data. No EBITDA, operating expenses, net income, or finance cockpit. Budget is still central, but framed as sales/volume/revenue budget achievement, not P&L.

### EVP User Intent

The EVP needs a hybrid view:

- Weekly/monthly scorecard as the primary mode.
- Action cockpit as the secondary mode.
- Drilldown available through expandable sections and eventually an assistant.

The EVP should quickly know whether the commercial team is on plan, which DSMs/districts are driving the gap, what customer or market movements matter, and which action queues need attention.

## Preserve And Elevate The Filter Model

The existing filters should remain because they are the dashboard's shared language.

### Period

- 7D: weekly scorecard monitoring
- MTD: month-to-date management
- QTD: quarter-to-date management
- YTD: year-to-date management

### Comparator

- vs PP: current period versus previous matching period
- vs PY: current period versus same period previous year

### Unit

- MT
- Bags

### Reference Month

Used for review and retrospective reporting.

Examples:

- MTD + May 2026 + vs PY means: May 2026 month-to-date or full May if historical, compared to May 2025.
- 7D + Live + vs PP means: latest 7 days compared with the prior 7 days.
- YTD + March 2026 means: year-to-date as of March 2026.

### Required UI Clarifier

Every executive view should show a persistent label:

Viewing: MTD · May 2026 · vs PY · MT

This prevents confusion when reviewing historical months.

## EVP Page Structure

### 1. Top Scorecard: Four Cards Only

The top of the EVP page should contain only four cards. These are not generic KPI cards; they are scorecard cards.

#### Card 1: Volume vs Budget

Purpose: shows whether the business is physically moving enough product.

Fields:

- Actual volume
- Budget pace
- Achievement %
- Gap in MT or bags
- Secondary delta vs PP or PY

Example:

- 54,446 MT actual
- 58,300 MT budget pace
- 93% achievement
- -3,854 MT gap
- +8.4% vs PY

#### Card 2: Net Sales vs Budget

Purpose: shows commercial value creation, not P&L.

Fields:

- Net sales
- Sales budget pace
- Achievement %
- Sales per MT / bag
- Secondary delta vs PP or PY

#### Card 3: DSM / District Performance

Purpose: shows where management action is needed.

Fields:

- DSMs/districts above budget pace
- DSMs/districts below 80%
- Top overperformer
- Biggest recovery district

Important: region is only a grouping. DSM/district is the actionable layer.

#### Card 4: Customer & Market Momentum

Purpose: shows whether the market base is expanding, shrinking, or shifting.

Fields:

- Active customers
- New/reactivated customers
- Declining A/B customers
- Silent customers
- Whitespace or brand coverage opportunity

### 2. Action Cockpit Strip

A compact row below the four cards. This should not become another KPI wall.

Examples:

- 5 DSMs below budget pace
- PHP 42M sales gap vs budget
- Visayas Poultry behind plan
- 12 A/B customers declining vs PY
- Top recovery: Cebu district needs +180 MT

Each item should be clickable and open the relevant section below.

### 3. Region Summary Bands

Use three compact bands:

- Luzon
- Visayas
- Mindanao

Each band should show:

- Volume achievement
- Sales achievement
- vs PP/PY trend
- DSMs on track / total DSMs
- biggest issue
- biggest opportunity

The region band is not the final detail. It is a doorway into DSM/district.

### 4. DSM / District Expandable Scorecard

This should become the heart of the EVP dashboard.

Default mode:

- Show exceptions and top performers only.

Expanded mode:

- Show all DSMs/districts.

Suggested columns:

- Region
- DSM / District
- Actual volume
- Budget volume
- Achievement %
- Gap MT / bags
- Net sales actual
- Net sales budget
- Sales achievement %
- vs PP / vs PY
- Active customers
- Declining customers
- Main issue
- Recommended action

### 5. Expandable Drilldown Boxes

Below the DSM/district scorecard, add expandable boxes:

#### Customer Movement

- Top declining customers
- Top growing customers
- Silent high-value accounts
- Reactivated customers

#### Brand / BU Coverage

- Whitespace by region/district
- Brand penetration
- Under-sold BU lines
- Top cross-sell candidates

#### Field Execution

- Patrol visits
- active TSRs
- follow-up completion
- new stores
- DSM/TSR activity gaps

#### Commercial Guardrails

Use this instead of P&L.

- Low GM/Ton accounts
- Negative GP accounts
- pricing review candidates
- discount discipline issues

This belongs in EVP only as commercial hygiene, not finance/P&L.

## Budget Data Strategy

Budget should be the main scorecard comparison. PP/PY should be secondary trend context.

Budget answers:

- Are we on plan?

PP/PY answers:

- Are we improving or weakening?

### Current Known Budget Availability

The current desktop already exposes:

- FY2026 national budget
- monthly volume budget
- regional budget
- net sales budget
- gross margin budget
- achievement %
- monthly actual vs budget

The API also contains budget fields in dashboard, budget, and team endpoints.

### Known Gap

Real RSM/DSM-level budgets are not fully modeled. The code currently indicates RSM targets are placeholders or zero in some paths.

### Recommendation

For v1, use this rule:

1. Use official DSM/district budget if available.
2. If official DSM/district budget is not available, allocate region budget by prior-year DSM/district volume share.
3. Label allocated values clearly as "allocated budget" until official targets are loaded.

This keeps the EVP dashboard useful immediately while avoiding false precision.

## Chatbot / Assistant Layer

Add an assistant later, but do not make it the primary dashboard.

Name idea:

Ask VieForce

The dashboard should answer:

- Are we on track?
- Where is the gap?
- What needs attention?

The assistant should answer:

- Why?
- Which accounts?
- What changed?
- What should we do next?

Example prompts:

- Why is Visayas behind budget this month?
- Show top declining customers in Luzon.
- Which DSMs are below 80% of budget pace?
- Summarize May 2026 MTD vs PY.
- What should we discuss in the Monday sales meeting?
- Which brands have the biggest whitespace in Mindanao?

Recommended v1 approach:

- Reserve a right-side Ask VieForce panel.
- Start with curated prompt buttons and deterministic summaries.
- Add full conversational retrieval later after endpoint contracts are stable.

## Page-By-Page Improvement Themes

### Home

- Make Home an executive launchpad, not a second version of every page.
- Keep 3-4 national KPIs.
- Add top actions and deep links.
- Replace static ticker with live alert cards.

### Sales

- Split detailed Pending PO analysis into an expandable section or sub-tab.
- Add budget achievement and variance explanation.
- Separate "scorecard" from "rankings."

### Accounts Receivable

- Add action workflow: owner, next action, promised payment date, dispute flag.
- Make aging buckets clickable filters.
- Disable irrelevant period filters or clearly mark AR as live snapshot.

### Inventory

- Add stockout risk, overstock risk, transfer candidates, and production shortfall.
- Connect stock to pending demand and speed.
- Make stale production data highly visible.

### Speed Monitor

- Add required daily pullout to hit target.
- Show working days and calendar assumptions clearly.
- Add plant-level reasons for gaps.

### Customers

- Add saved segments:
  - high AR
  - declining volume
  - low margin
  - silent 30/60/90
  - whitespace
- Add row actions:
  - open profile
  - issue SOA
  - assign follow-up
  - silence alert

### Customer Detail

- Add a single Next Best Action panel above the KPI wall.
- Keep SOA export.
- Add SOA generated-history later.

### Customer Intelligence

- Turn alerts into an action queue.
- Add priority, owner, due date, status, and reason.
- Strengthen silence governance with reason and expiry.

### Margin Alerts

- Frame as commercial guardrails.
- Add reason classification:
  - price
  - cost movement
  - discount
  - freight
  - returns
  - wrong SKU/customer mapping
- Sort by recoverable impact.

### Sales Team

- Split performance scorecard from org/admin information.
- Avoid placeholder target rows.
- Add drilldown: RSM to DSM to TSR/customer.

### Budget & P&L

- Keep as a detailed finance/budget page.
- Rename if needed to separate sales budget from P&L.
- EVP should consume the budget scorecard, not the full P&L page.

### Itemized Sales

- Treat as a spreadsheet workspace.
- Add sticky first columns, sticky header, SKU search, collapse all/expand all.
- Keep export aligned to current filters.

### Admin Team Hierarchy

- Add audit history.
- Hide default PIN messaging once production-ready.
- Validate duplicates and invalid hierarchy.

## Implementation Roadmap

### Phase 1: EVP Clarity Sprint

Goal: remove overload and create the Sales & Marketing scorecard.

Deliverables:

- Remove P&L card from EVP.
- Add four-card scorecard.
- Add viewing context label.
- Add action cockpit strip.
- Add region bands.
- Add DSM/district expandable scorecard shell.
- Use existing budget data where available.
- Clearly label allocated/proxy budgets.

### Phase 2: Data Contract Sprint

Goal: make the scorecard reliable.

Deliverables:

- Standardize period date logic across endpoints.
- Standardize 7D definition.
- Create shared budget module instead of duplicated budget constants.
- Define official budget contract:
  - national
  - region
  - DSM/district
  - RSM if needed
  - brand/BU if available
- Add endpoint payload for EVP scorecard.

### Phase 3: Action Queue Sprint

Goal: move from dashboard to operating system.

Deliverables:

- Customer movement queue.
- DSM/district gap queue.
- Field execution queue.
- Commercial guardrail queue.
- Owner/status/next-action fields where appropriate.

### Phase 4: Assistant Sprint

Goal: add drilldown without clutter.

Deliverables:

- Ask VieForce panel.
- Curated prompts.
- Deterministic summaries from existing endpoints.
- Later: conversational data assistant.

## Open Questions For Further Brainstorming

### Budget And Targets

1. Do official DSM/district budgets already exist outside the current code?
2. If yes, where are they stored: Excel, SAP, Supabase, or another planning file?
3. Should DSM/district budget be volume-only first, or volume plus net sales?
4. Do we need budget by BU/brand, or is geography enough for v1?
5. Should budget achievement use shipping days, calendar days, or full month pacing?

### EVP Workflow

6. What is the EVP's weekly meeting rhythm?
7. Should the default EVP period be 7D, MTD, or last selected?
8. Which is more important on first load: budget gap or customer risk?
9. Should the EVP page be optimized for desktop, tablet, or mobile first?
10. Should the EVP dashboard show only exceptions by default?

### DSM / District Layer

11. Is district synonymous with DSM ownership in the current org?
12. Should the DSM table group under Luzon/Visayas/Mindanao, or show a national ranking first?
13. What achievement threshold should define "behind": below 80%, below 90%, or below budget pace?
14. Should the table include RSM as a separate grouping layer?

### Customer Momentum

15. What defines an A/B customer?
16. What defines declining: vs PP, vs PY, or below 90-day average?
17. Should silent accounts be based on invoices, orders, or visits?
18. Should new/reactivated customers count by invoice, order, or first shipment?

### Field Execution

19. How much should Patrol data influence the EVP scorecard?
20. Should visits be treated as leading indicators or only supporting context?
21. Do we have follow-up completion data, or only visit/activity counts?

### Commercial Guardrails

22. Should margin/pricing alerts appear on EVP by default?
23. What is the minimum threshold for a pricing alert to be EVP-worthy?
24. Should negative margin always be shown, or only if material?

### Assistant

25. Should Ask VieForce be available to all roles or EVP/admin only first?
26. Should it answer only from current filters or allow cross-period questions?
27. Should assistant answers cite the underlying table/endpoint?
28. Should it create action items or only explain data?

## Audit Status

No more broad audit is needed to produce this strategy document. The current findings are enough to define the direction.

Before implementation, a focused audit is still recommended for:

- exact EVP data contract
- DSM/district budget source
- period/date consistency
- 7D definition consistency
- which metrics are live versus placeholder/proxy
- current endpoint response shapes for dashboard, budget, team, sales, intelligence, and DSM home

## Recommended Next Step

Approve the strategic direction:

EVP Dashboard = Sales & Marketing Scorecard, budget-first, weekly/monthly hybrid, DSM/district actionable layer, region as grouping, expandable drilldowns, chatbot reserved for explanation and deeper questions.

After approval, create a specific implementation plan for Phase 1.
