---
mapped_date: 2026-05-03
repo: vieforce-hq
focus: arch
---

# Repository structure — VieForce HQ Desktop

```
vieforce-hq/
├── server.js                 # Express app entry (API only)
├── package.json
├── vercel.json               # Static hosting headers + CSP
├── app.html                  # Main app shell (role dashboards)
├── index.html                # Entry / routing landing
├── vieforce-hq-desktop.html  # Desktop-focused shell
├── pg-admin-team.html        # Admin UI
├── js/
│   ├── api.js                # fetch wrapper, API_BASE, session headers
│   ├── auth.js               # Login / session / logout
│   ├── charts.js             # Chart helpers
│   ├── supabase.js           # Client-side Supabase (legacy paths)
│   ├── rsm-home.js / dsm-home.js / evp-home.js / pg-admin-team.js
│   └── …
├── api/
│   ├── _auth.js              # Session + service token + applyRoleFilter
│   ├── _db.js                # SAP pools + query helpers
│   ├── _scope.js             # User → SAP scope resolution
│   ├── auth/login.js         # POST PIN login (service role)
│   ├── dashboard.js / sales.js / ar.js / inventory.js / speed.js
│   ├── customers.js / customer.js / customer-soa.js / search.js
│   ├── margin.js / budget.js / intelligence.js / team.js
│   ├── itemized.js / itemized-meta.js
│   ├── analytics-*.js        # SKU matrix, brand coverage, buying patterns
│   ├── diag.js               # Diagnostics / probes (sensitive)
│   ├── silence.js / unsilence.js / silenced.js + lib/silence.js
│   ├── admin/                  # SAP reps, upsert, reset-pin, remove-user
│   └── lib/                    # customer-map, brand-family, shipping_days, …
├── migrations/               # Supabase / RLS SQL
├── tests/                    # Node native tests (*.test.js)
├── tests/e2e/                # Playwright specs (TypeScript)
├── scripts/                  # One-off tools + run-tests.mjs
├── lib/cache.js              # Shared caching helper
└── test-results/             # QA reports (markdown)
```

## Naming conventions

- **API routes:** kebab-case path segments map to file names (`analytics-sku-matrix.js` → `/api/analytics/sku-matrix`).
- **Tests:** `*.test.js` colocated under `tests/`, imported by `scripts/run-tests.mjs`.
- **Environment:** `.env.local` (not committed) — see `.env.example` if present in repo.

## Branch note (local)

- Active development has been on **`design-upgrade`** (tracks `origin/design-upgrade`). Align release tagging with the branch you intend to deploy from (`master` vs `design-upgrade`) before Beta cut.
