# Spec — Margin Dissection → HQ Margin Explorer integration

**Date:** 2026-06-06 · **Status:** approved (Mat GO) · **Source of truth for math:** `C:\VienovoDev\_margin_audit\METHODOLOGY.md` + `HANDOVER.md` + `gen_payload2.py`.

Adapt the standalone "Margin Dissection Analyser" into the existing **VieForce HQ Margin Explorer** tab. Enhance, don't rebuild. Preserve every data decision exactly.

## Decisions (locked with Mat)
- **Enhance the existing Margin Explorer tab** (not a new/parallel tab).
- **Live SAP query + in-memory cache** via the existing Node/Cloud Run endpoint (NOT a precomputed Supabase cube; HQ has no Python backend).
- Bring in **all four**: SSG-level bridge (works YTD), product-mix bridge, cross-DB trajectory, server-proxied AI read.
- **Chart.js** (HQ's existing charting), VESS palette (#004D71 / #7BB52E / #FFC72C / #00A8CC / #E53935).

## Scope correction (important)
The Dissection tool is **finished-feed GM/ton**. Scope = **Live group 103 / Old groups 103+104** (feed). This DIFFERS from the current Explorer's `(103,105,102)` (feed+trading+basemix). The new Dissection panels (trajectory/bridge/mix/ingredient) use **feed-only** scope per the locked methodology; the hero re-scopes to finished-feed so the tab is internally consistent as a feed-margin tool.

## Data decisions to PRESERVE (do not re-derive)
- GM = `INV1.GrssProfit` (batch-actual COGS, `EvalSystem='B'`), revenue=`LineTotal`, kg=`InvQty`, tons=kg/1000.
- Per-DB feed scope: **Live=103**, **Old=103+104** (104≈70% of 2025; Live codes on Old drop Vismin).
- Stitch: 2025=Vienovo_Old (Sep–Dec), 2026=Vienovo_Live (Jan→current). `CANCELED='N'`, `InvQty>0`, returns (ORIN/RIN1) netted negative.
- Region: 2026 = `INV1.OcrCode2` prefix (L-/V-/M-); 2025 = `INV1.WhsCode` map → Mindanao {BUKID,SOUTH,CAG,ALAE}, Visayas {HOREB,BAC,ARGAO}, Luzon {AC,PFMCIS} + all grp-103; default Visayas. (grp 103 in Old = Luzon.)
- SSG = `[@OITMSSG].Name` via `OITM.U_SSG`.
- Ingredient ₱/ton = recipe intensity (`WOR1.IssuedQty`÷`OWOR.CmpltQty`, FG grp103 / comp grp101, per SSG) × monthly market price (`PCH1`/`OPCH` grp101), blended by the selection's SSG tonnage mix. NO BOM master. Market-priced; booked COGS lags it.
- Customer codes do NOT map across the Jan-2026 consolidation (one book per customer).

## Backend (Node, live + cached)
- **`api/lib/margin_cube.js`** (new): builds the monthly SSG cube live across both DBs (queryH Old + query Live), returns rows `{midx, ssg, bu, region, cust, rev, gp, kg}`; plus recipe `intensity[ssg][ing]` and monthly `basket[ing]` price. Pure compute functions exported for tests:
  - `trajectory(rows, months)` → per-month `{gm_per_ton, rev_per_ton, cogs_per_ton, gm_pct, tons}`.
  - `ssgBridge(rowsBase, rowsCmp)` → `{base, price, mix, cost, interaction, compare}` (METHODOLOGY §3).
  - `mixBridge(rowsBase, rowsCmp)` → per-SSG `{ssg, contribution}` summing to the Mix bar (§5).
  - `ingredientContribution(rows, intensity, basket, bI, cI)` → top-N `{name, contribution}` (§4).
  - Invariants: Price+Mix+Cost+Interaction = ΔGM/ton; Σ mixBridge = Mix bar.
- **`api/margin-explorer.js`**: scope→feed-only; call margin_cube; add `trajectory`, `bridge` (SSG spine; keep RM/Pkg/Feedtag as cost-bar drilldown), `mix_bridge`, recipe-weighted `ingredients`. Honor period/region/bu/customer/ssg filters; bridge base=first month of range, compare=last.
- **`api/margin-ai.js`** (new): POST; takes the computed digest; calls Anthropic `claude-sonnet-4-6` with `ANTHROPIC_API_KEY` env (server-side only); interprets, never recomputes. Session-auth like other endpoints.

## Frontend (`js/margin-explorer*.js`, Chart.js)
Add trajectory panel (GM/ton + rev/ton), product-mix bridge panel, SSG-spine bridge, recipe-weighted ingredient render, SSG filter, and an "✦ AI read" button → `api/margin-ai`. VESS palette.

## Definition of done
Endpoint live+cached; panels reach parity with the standalone (5 panels, all filters, AI read server-proxied); numbers reconcile to the standalone for a spot-check selection (e.g. National/all, Jan26→May26); VESS-styled; unit tests on the aggregation pass.

## House-rule note
HQ reads the analytics replica directly (read-only `gsheet`) — its established pattern; the global "Service Layer" rule governs transactional SAP in other apps, not this reporting read. No new tension.
