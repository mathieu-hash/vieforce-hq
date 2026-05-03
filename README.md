# VieForce HQ

Sales intelligence API (Express + SAP) and static dashboard UI (Vercel).

## Quickstart

```bash
npm install
cp .env.example .env.local   # fill SAP + Supabase + HQ_SERVICE_TOKEN
npm start                      # API on PORT default 8080
```

## Scripts

| Script | Purpose |
|--------|---------|
| `npm test` | All unit tests (`tests/*.test.js`) — Windows & Linux |
| `npm run ci:scan` | Fail if `SUPABASE_SERVICE_ROLE_KEY` appears in `js/` or root HTML |
| `npm run smoke` | Remote API smoke (`HQ_API_URL` required). See [docs/SMOKE.md](docs/SMOKE.md) |

## CI

GitHub Actions runs tests + client scan on **Ubuntu and Windows** for every PR to `master`, `main`, or `design-upgrade`.

Planning artifacts live under `.planning/` (roadmap, runbook, Patrol contract).
