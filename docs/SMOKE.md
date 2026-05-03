# API smoke checks (ENG-03)

Run before a release or after deploying Cloud Run:

```bash
HQ_API_URL=https://<your-cloud-run-host>.run.app node scripts/smoke-api.mjs
```

**What it checks**

| Path | Expected (no session) |
|------|------------------------|
| `GET /` | 200 |
| `GET /api/diag` | **401** once Phase 1 is deployed; **200** prints a WARN until then (legacy open diag) |
| `GET /api/dashboard?...` | 401 or 200 depending on route auth |
| `GET /api/sales?...` | 401 or 200 |

Uses only `fetch` — no Playwright or credentials. For full route coverage, use `tests/e2e/` with `HQ_API_URL` and optional test credentials when Playwright is installed (`npx playwright test tests/e2e`).
