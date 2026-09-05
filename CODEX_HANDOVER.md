# Margin Explorer evolution — handover for the next agent

Written 2026-09-05 for an AI coding agent (Codex) taking over the branch. Everything
here is verifiable in the repository; nothing depends on the previous conversations.
The French owner-facing narrative lives in `MARGIN_EXPLORER_HANDOFF.md`; this file is
the operational version.

---

## 0. Status in one paragraph

Branch `margin-explorer-evolution` of `github.com/mathieu-hash/vieforce-hq`, 29 commits
above `master`, fully pushed. Production is `master @ 548dd3d`, untouched. The branch
evolves the **Margin Explorer** page of VieForce HQ (an internal SAP-B1-backed BI
dashboard for Vienovo Philippines, an animal-feed manufacturer) with four owner-approved
UI changes plus an approved fifth KPI card, re-skins the new boxes in the shell's theme,
brings back the four "composition lenses" under the net bridge, and adds page-feel
polish. Verified offline against a mock backend: 6 scenarios, 0 console errors, dark and
light. **Not merged, not deployed.** Merging = deploying (see §2).

---

## 1. Rules from the owner (Mathieu) — do not violate

1. **"Il ne faut pas tout changer, juste change ce que je te dis de changer."**
   Only the changes listed in §4 are in scope. A larger page restructure was built and
   then removed (commits `00ab43d`, `25f411a`, `d4fa386`). Never reintroduce it.
2. **Use the VieForce HQ colour code**, in both themes: shell tokens only (§3.4).
3. **One representation per measure.** A share-vs-margin quadrant and a share
   "dumbbell" were built, judged redundant by the owner, and removed (`f9d1e52`).
   Do not add charts that restate a table next to it.
4. **Lenses do not sum** to each other nor to the bridge's Mix bars. Never draw a
   visual link between a lens total and a bridge bar; never show a grand total across
   lenses.
5. **Never write to SAP.** Read-only SQL only. Never commit credentials (`.env*` is
   ignored; the repo is public).
6. **The v1 controller `js/margin-explorer.js` stays the page.** The new modules are
   mounted into it, they do not replace it.

---

## 2. Environment, deploy, and how to run

| Item | Value |
|---|---|
| Local checkout | git worktree `C:\VienovoDev\vieforce-hq-worktrees\margin-explorer-evolution` (the main clone `C:\VienovoDev\vieforce-hq` stays on `master`; it carries one uncommitted dirty diff on `js/margin-explorer-bridge.js`, an `animation:false` fix made obsolete by this branch, which deletes that file) |
| Remote | `origin` = `https://github.com/mathieu-hash/vieforce-hq.git` |
| Production deploy | **A push to `master` is the deploy**: `.github/workflows/deploy-cloud-run.yml` (API → Cloud Run `vieforce-hq-api`, `asia-southeast1`, project `vieforce-vpi`) and Vercel (static front-end) both trigger on `master`. `ci.yml` runs tests on the same trigger. |
| Preview | `https://vieforce-hq-git-margin-explorer-e-8d6384-mathieu-7782s-projects.vercel.app/app.html` (Vercel SSO, then the VieForce PIN login; only the owner can log in) |
| Backend reachability | SAP (`analytics.vienovo.ph:4444`) is reachable only from Cloud Run. The laptop cannot query it. The deployed API is the only wire to real data. |
| Offline harness | `python -m http.server 8912` from the repo root, then open `http://127.0.0.1:8912/test/margin-explorer-harness.html?scenario=happy`. `file://` does not work. Chart.js comes from `cdn.jsdelivr.net` (network needed for that one script). |
| Verification | `python test/verify_harness.py` (Playwright). Exit 0 = 6 scenarios, no console error. Screenshots land in `test/screenshots/` (git-ignored). **This is the bar for "verified".** |
| Syntax bar | `node --check js/<file>.js` on every touched file. The code is **ES5**: `var`, function declarations, no arrow functions, no template literals, no `let`/`const`, no optional chaining, no spread, no `class`, no destructuring. The shell is ES5 and there is no build step. |
| CSP | No new external hosts. Inline SVG is fine. |
| Theme convention | The shell sets `data-theme` to the **empty string** for dark and `"light"` for light. Full dark palette on `:root`; light overrides only under `:root[data-theme="light"]`. `[data-theme="dark"]` **never matches**. |

Commit messages: imperative mood, specific. The repo's history reads as one sentence per
commit describing what changed and why.

---

## 3. Architecture

### 3.1 Files and roles

```
app.html                      shell (16 pages, inline CSS tokens at lines ~26-110); loads css/mexp2.css and the scripts below
css/mexp2.css                 all styling for the mexp2 modules (1,757 lines; sections numbered 1-13)
js/margin-explorer.js         v1 page controller (kept): filter bars, period bar, 5 KPI cards, ingredient table,
                              AI-read button, renderBridgeDrills, applyScope, mounts the mexp2 panels
js/margin-explorer-matrix.js  v1 Drill Matrix (now the "Snapshot" tab of the matrix box)
js/margin-explorer-dissection.js  v1 dissection block (trajectory chart + ingredient contribution)
js/mexp2-contract.js          view-model shape, six render states, panel lifecycle, constants
js/mexp2-wire.js              the REAL API response shape, derived from backend code; the only wire description
js/mexp2-fmt.js               every formatter (nothing else formats a number)
js/mexp2-store.js             single state, scope key, `vm.prev` channel for the previous scope; defines MEXP2.panel()
js/mexp2-api.js               normalise() / mapCore / mapDissection: the only code that knows the wire
js/mexp2-svg.js               hand-drawn SVG primitives: waterfall, bullet, sparkline; re-theme without JS
js/mexp2-charts.js            private Chart.js registry (rebuilt on theme change)
js/mexp2-panel-bridge.js      MEXP2.panel "bridge" (reported) and "netbridge" (net) — waterfall, badges, strip, LENSES
js/mexp2-panel-trendmatrix.js MEXP2.panel "trendmatrix" — the 12-month category matrix + Snapshot tab
js/mexp2-adapter.js           vmFromV1(coreRaw, dissRaw, scope) → view model; exposes applyScope, renderAll, ...
test/margin-explorer-harness.html  the whole page on a stub shell fed by the mock
test/mexp2-mock.js            deterministic raw-wire mock of /api/margin-explorer, six scenarios
test/verify_harness.py        the verification script (§2)
test/README.md                harness notes
docs/discount-probe.sql       8 read-only SELECTs on SAP to break OINV.DiscSum into discount types (never run yet)
MARGIN_EXPLORER_HANDOFF.md    owner-facing handoff (French)
```

### 3.2 Load order in `app.html` (lines ~3712-3724)

```
mexp2-contract → wire → fmt → store → api → svg → charts → panel-bridge → panel-trendmatrix → adapter
→ margin-explorer-matrix → margin-explorer-dissection → margin-explorer
```
Hard constraints: `store` before the panels (it defines `MEXP2.panel`); all `mexp2-*` before
`margin-explorer*.js`. Adapter and panels only reference each other at runtime.

### 3.3 Data flow and seams

```
margin-explorer.js (v1)  --apiPost('margin-explorer', {include:'bridge,movers,gap'})--> core payload
                         --apiPost('margin-explorer', {include:'dissection'})-------> dissection payload
      │
      ├─ MEXP2.adapter.vmFromV1(coreRaw, dissRaw, scope)   → contract view model (via MEXP2.api.mapCore/mapDissection)
      ├─ #mexp-matrix-host → MEXP2.panel("trendmatrix")
      ├─ #mexp-bridge-host → MEXP2.panel("bridge")          (reported)
      └─ #mexp-net-host    → MEXP2.panel("netbridge")       (net of discount; strip + 4 lenses)
```
- **THE scope seam:** `applyScope(patch)` in `margin-explorer.js` (~line 538), installed as
  `MEXP2.adapter.applyScope`. Accepted keys: `period`, `refMonth`, `region`, `bu`,
  `customer`, `compare`, `groupBy`, `unit`, `drill`. Region values `Luzon|Visayas|Mindanao|ALL`,
  BU values `DISTRIBUTION|KEY ACCOUNTS|PET CARE|ALL` — these equal the lens row keys, which is
  why a lens row click can pass `{region: key}` straight through.
- Panels find the seam via `scopeFn()` (adapter → `window.MEXP_applyScope` → store).
- Request cancellation is a sequence guard, not an `AbortController`.

### 3.4 Theme tokens

`css/mexp2.css` defines `--mx2-*` tokens. Since `dabc3e8` they **resolve to the shell's tokens**
with fallbacks, e.g. `--mx2-pos: var(--green, #97D700)`, `--mx2-accent: var(--blue, #00AEEF)`,
`--mx2-surface: var(--surface, …)`, `--mx2-border: var(--glass-border, …)`. Dark block starts at
`--mx2-bg:` (~line 74); light block at `:root[data-theme="light"] {` (~line 183).
**Trap:** the string `[data-theme="light"]` first appears in a *comment* at line 38. Anchor any
scripted edit on `:root[data-theme="light"] {`, never on the bare selector text (a remap once
landed on the dark block because of this).

Panels are the shell's `.card`: 12px radius, `backdrop-filter: blur(8px)`, hairline `::before`,
hover border. Chips inside the boxes are the page's own `.mexp-chip`: 8px radius, solid `--blue`,
white text when active. Table headers follow `.tbl th` (11px, 700, 0.08em, uppercase).

---

## 4. What the branch changes (the approved scope)

| # | Change | Where |
|---|---|---|
| ① | "Drill Matrix" box → 12-month category matrix (rows = SSG with tonnage, month columns, running month dashed, AVG row from payload, <5 MT cells withheld, five box-local filters, row click filters the page, cell click re-anchors the bridge). Old Drill Matrix = "Snapshot" tab. | `mexp2-panel-trendmatrix.js` |
| ② | GM/ton bridge as **SVG waterfall** (no canvas; the Chart.js canvas rendered blank in production). Always a state: loading / no bridge for this scope + server reason / "Showing previous scope". Reported and net bridges on **one shared scale** (union domain). | `mexp2-panel-bridge.js`, `mexp2-svg.js` |
| ③ | Small print → three badges `partial · N of M days`, `mix unstable`, `reconciled` + a details toggle. | `mexp2-panel-bridge.js` |
| ④ | Bottom section: one net bridge (same SVG), a three-number strip Δ reported · Δ discount · Δ realised (stacked vertically ≥1100px), and the **four composition lenses** Category · BU · Region · Customer as a 2×2 grid of shell cards. Per row: initials avatar, name, NEW/GONE tag when one-sided, signed effect bar from a centred zero on **one scale across the four lenses** + value, share before → after + shift pill (neutral), GM/t before → after. Header: lens total as sub-KPI, `7 of 12 rows · 73% of tonnage` (coverage = Σ share-after of the listed rows). Region/BU/Customer rows click → `applyScope`. One fixed-layout `<table>` per card. | `mexp2-panel-bridge.js` (`lensesOf`, `lensCard`, `lensRow`, `paintLenses`), `css/mexp2.css` §12 |
| opt | Fifth KPI card **GM / kg net of discount** from `discount_overlay.gm_per_kg_net_of_discount`; 5 columns ≥1100px. | `margin-explorer.js` |
| skin | Shell theme on every mexp2 box (§3.4). | `css/mexp2.css` |
| feel | Staggered card entrance (first paint only), KPI delta pills, radial glow behind the KPI row, sticky second filter bar, hover lift on panels/rows, `prefers-reduced-motion` honoured. All CSS scoped to `#pg-margin-explorer`; the v1 JS is untouched. | `css/mexp2.css` §13 |

Plus twelve bug fixes to the original code (details in `MARGIN_EXPLORER_HANDOFF.md` §3, commits
`febc1ab` → `a0b16d7`).

### The business fact that justifies the net bridge and the fifth card

`INV1.LineTotal` is net of the line discount but **gross of the header discount `OINV.DiscSum`**
(`DocTotal = Σ LineTotal − DiscSum + VatSum + TotalExpns` reconciles on 10,555 / 10,555
invoices in 2026). So every displayed margin (`hero.gm_per_kg`, `gross_profit`, `matrix.gp`)
is ~12% above the realised margin, and the field is misleadingly called `net_sales`. The honest
number is computed on every response in `discount_overlay` and was read nowhere. Observed
Jul→Aug 2026: reported bridge −202 ₱/t, realised bridge +8 ₱/t (a list-price cut offset by a
rebate cut).

---

## 5. Verified API facts (do not rediscover)

- `matrix.rows` is never truncated; `Σ rows[].kg / 1000` is the exact scope tonnage. `hero` has no volume field. Zero-tonnage rows carry `0`, not `null`.
- `canonical_bridge` / `net_bridge` are a true Bennet decomposition (exact by construction). Bars are pre-rounded: a client residual is rounding drift (~3 ₱/t), never a decomposition failure. Phase-A `bridge` is a different (Paasche/Laspeyres hybrid) decomposition: do not confuse.
- Discount is allocated pro-rata to line value, not tonnage.
- `group_by` accepts `region, bu, dsm, brand, species, sales_group, ssg, customer, sku`; unknown → silently `sales_group`.
- **Server filters are only `region`, `bu`, `customer`.** `dsm` is a group-by, not a filter.
- Trust signals: `mix_ordering.sign_stable` (false ⇒ the customer/product split is an artefact; lenses are then replaced by the sentence), `mix_detail.churn_dominated`, `significance.verdict`.
- `meta.window` has a `toISOString` timezone bug (can be a day ahead). Prefer `hero.compare_window` / `dissection.window`.
- `hero` (item groups 103,105,102) and `dissection` (103 only, credit notes netted) are different universes; they do not reconcile.
- Dissection anchors are a **month pair** (first and last complete months in the period), not the period. YTD ⇒ Jan→Aug.
- Lens rows on the wire: `{key, value, share0_pct, share1_pct, share_shift_pp, gm_ton0, gm_ton1, tons0, tons1}`, server-truncated to `LENS_ROW_CAPS = {ssg:12, bu:8, region:8, customer:15, sku:15}`, sorted by |value|. `gm_ton0 === null` ⇒ entered in the compare window; `gm_ton1 === null` ⇒ gone.

---

## 6. Open items, ranked

1. **Merge to `master`?** Owner's decision. Only after checking the preview with real data. Push = deploy (Cloud Run + Vercel). Rollback = revert the merge commit and push.
2. **Lenses over time** (owner's idea "like the finished-feed matrix"): rows = customers/regions/BU/categories, columns = months, cell = share or net GM/t. For SSG the monthly cube exists; for the other dimensions it needs backend **B3** (generalise `api/lib/margin_cube.js` to any dimension). A client-side "share %" unit on the SSG matrix is feasible but invasive in `mexp2-panel-trendmatrix.js` (`cellValue` has no month total; AVG row, Moving filter, vs-LY delta all key off the unit).
3. **Backend changes specified, not implemented:** B1 accept `dsm` as a filter (join exists for `group_by=dsm`); B2 expose line discount (`PriceBefDi × Quantity − LineTotal`) and financial credit notes separately (enables a real gross → net bridge); B3 above; B4 null `gm_ton`/`gm_pct` at source when `tons < 5`.
4. **`docs/discount-probe.sql`** (8 read-only SELECTs) has never been run; until it is, `OINV.DiscSum` is one bucket and cannot be split by reason.
5. **Minor known:** dead CSS sections `.mx2-g2n-*`, `.mx2-kpi-*` in `mexp2.css` (harmless); `renderWindow` re-displays `meta.window` (timezone); `compare_note` under the KPIs still 10px; the "AI read" button now goes through `window.apiPost` (session handling, 401 → logout) — technically outside the four changes, kept as a repair.
6. **Security, unresolved:** three public repos (`vieforce-hq`, `vieforce-patrol`, `vpi-dashboard`) expose SAP host/port/db names/user and all SQL (no secrets). `api/_db.js` uses `encrypt: false, trustServerCertificate: true` to `analytics.vienovo.ph:4444`; `encrypt: true` was proposed and **not authorised** (confirm with the SQL admin first or the connection drops).

---

## 7. Gotchas that cost time

- **Harness scroll container** is `.content` (`overflow-y: auto`), so `body.scrollHeight` equals the viewport; Playwright `full_page` screenshots do not capture the page. Use a tall viewport (3600px) or element screenshots.
- **Lens tables** use `table-layout: fixed` with percentage widths on the header cells (30/26/26/18). Auto layout starved the name column; grid layout could not align captions with rows. Keep the table.
- **Net host id** is `#mexp-net-host` (not `#mexp-net-panel`).
- `.mx2-panel` re-renders in place; entrance animations are CSS on insertion, so they run once and are not replayed on filter changes.
- `MEXP2.panel()` lives in `mexp2-store.js`; panels register by name; the v1 controller mounts them via `ns.adapter.mountPanels({...})` (`margin-explorer.js` ~line 366).
- The mock lens rows put the entering entity at index 3 (`gm_ton0: null`, `share0: 0`) — that is why every lens shows one NEW tag in the harness.
- Windows: files are LF; git warns about CRLF conversion on every touch. Harmless. Python scripts that print `→`/`₱` need `PYTHONIOENCODING=utf-8` on cp1252 consoles.

---

## 8. Commit map of the branch (newest first)

```
f9d1e52 Drop the lens quadrant and the share dumbbell: one representation per measure
3195dd2 Add the share-vs-margin quadrant …, row click as page filter, coverage in the header   (quadrant later removed; click + coverage stay; fixes the light-theme token remap)
4af5e61 Update the handoff for the lenses and the shell theme
8bd4ca7 Stack the three net numbers beside the waterfall on wide screens
4d595b2 Bring back the four composition lenses under the net bridge, and give the page a feed's feel
dabc3e8 Dress the mexp2 boxes in the VieForce HQ shell theme
4406da2 Correct the handoff: actual script load order, net-bridge host id, local verification note
f0e9cad Add the Margin Explorer handoff and the read-only SAP discount probe
c52141d … b391891 … 8acdc9b … 5d9c54e … 2d371c4 … d4fa386 … 25f411a … 00ab43d   re-cut to the four changes
db2cff5 … cbddbab   graft of the mexp2 modules and the (later removed) restructure
a0b16d7 … febc1ab   the twelve bug fixes on the original code
```
`git log --oneline master..HEAD` gives the full list; the messages are the changelog.

---

## 9. If you change something — the checklist

1. `node --check` every touched `.js`; grep your diff for `=>`, `` ` ``, `\blet\b`, `\bconst\b`, `?.`, `...` (ES5).
2. `python test/verify_harness.py` → exit 0, then look at `test/screenshots/happy-dark.png` and `happy-light.png`.
3. Both themes: anything with a colour must come from a `--mx2-*` token; light overrides go under `:root[data-theme="light"]` only.
4. Keep `MARGIN_EXPLORER_HANDOFF.md` §1 and §7 true; keep this file's §4 and §6 true.
5. One commit per change, imperative message that says what and why.
6. Do not push to `master`. Push to `margin-explorer-evolution`.
