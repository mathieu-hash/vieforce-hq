# test/ — offline pages for the Margin Explorer

Nothing in this folder is loaded by `app.html` or linked from the nav. These
pages exist because the real page is login-gated and `/api/margin-explorer`
answers 401 without a session, so the evolved page cannot be exercised
without a backend any other way.

| File | What it is |
| --- | --- |
| `margin-explorer-harness.html` | **The whole Margin Explorer page** on a stub shell, fed by the mock. Start here. |
| `mexp2-mock.js` | Deterministic raw-wire mock of `/api/margin-explorer` (`window.MEXP2.mock`), six scenarios. |
| `trendmatrix-test.html` | The category-by-month hero panel alone (`mexp2-panel-trendmatrix.js`). |

## Serve it

The harness uses absolute paths (`/css/...`, `/js/...`, `/test/...`), so it must
be served with the **repository root** as the document root. `file://` does not
work in the browser tool and Chart.js is pulled from cdn.jsdelivr.net, so the
machine needs network access for that one script.

Any static server rooted at the repo works. The zero-dependency one used during
development is the Windows PowerShell 5.1 listener `_serve.ps1` (kept in the
repo root but git-ignored; the same file lives in the mexp2 workspace):

```powershell
# from the repo root
powershell -NoProfile -ExecutionPolicy Bypass -File _serve.ps1 -Port 8912
```

Then open:

```
http://localhost:8912/test/margin-explorer-harness.html?scenario=happy
```

`?scenario=<id>` preselects a scenario; without it the harness reuses the last
choice made on that browser (`localStorage.hx_scenario`).

## The harness bar

* **Scenario** — `happy`, `empty-scope`, `malformed`, `bridge-unavailable`,
  `rounding-drift`, `trust-signals` (descriptions are in the option tooltips and
  in `mexp2-mock.js` section 3). Changing it re-enters the page with
  `loadMarginExplorer()`, exactly as the shell does on `navTo`.
* **fail phase A once / fail phase B once** — the next `include=bridge,movers,gap`
  (A) or `include=dissection` (B) fetch rejects once with a 504; click the page's
  own Refresh (or "re-enter page") to trigger it. Tests the stale-scope guards.
* **re-enter page** — calls `loadMarginExplorer()` again; filters set on the page
  must stay sticky.
* **Theme button** — the shell's `toggleTheme()`: it sets `data-theme` on `<html>`
  to `""` for dark and `"light"` for light, persists `vf_theme`, and re-themes
  every Chart.js instance in the shell's `charts` map.
* **apiFetch calls / console errors** — running tallies. `console errors` counts
  both uncaught `window.onerror` events and every `console.error` call. On
  `happy` it must read 0. On `malformed` the page's own error path is expected
  to log (that is the scenario's purpose), so a non-zero count there is not a
  harness failure — read the log line to see which renderer reported.
* The log pane shows every `apiFetch` call with its params and the mock source
  (`synthetic:<scenario>` or `fixture:<name>`), plus every stub invocation
  (`exportTableToXlsx`, `navTo`, `apiPost`, `logout`).

## What is real and what is stubbed

Real: every page module from `js/` in the exact order `app.html` loads them
(app.html:3711-3721), `css/mexp2.css` (not `css/hq.css`, which app.html never loads), the shell's `:root` /
`[data-theme="light"]` token blocks (copied verbatim from app.html:26-103), the
formatters `fc fn fp esc fv fvu fvl fcn` (app.html:3967-3980), the topbar
globals `PD CMP UT VF_REF_MONTH RG SEG` seeded from `localStorage` the way the
shell does (app.html:3738-3743), and `toggleTheme()` (app.html:7842-7866, minus
the home-combo chart rebuild that has no chart here).

Stubbed: `apiFetch` / `apiPost` (mock envelopes, same resolve/reject semantics
as `js/api.js`), `getSession` / `logout` (a fake 24h session under the shell's
`vf_session` key), `exportTableToXlsx` (logs the row count instead of
downloading), `navTo` / `loadPage` / `stampRefresh` (log only).

`window.HARNESS` exposes `{ scenario, failOnce, calls, errors, lastParams }`
for scripted checks from the console.

## ES5 gate

The shell and v1 are ES5, and so is everything here. The inline harness script
parses under the legacy JScript engine (`cscript //E:JScript`), the same gate
the `js/` modules go through. If you edit the harness, keep to `var`, function
declarations, no arrows / template literals / `let` / `const` / spread /
destructuring / optional chaining.
