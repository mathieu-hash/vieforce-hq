# Beta scope statement — VieForce HQ Desktop (PROD-01)

**Audience:** Stakeholders / pilot users  
**Rule:** Nothing listed **Beta / partial** should be sold as GA-complete without checking this table.

## GA for Beta pilot (expected to work end-to-end)

| Area | Notes |
|------|--------|
| Login (PIN) | Server-side verification; session TTL 24h |
| Role home dashboards | EVP / RSM / DSM shells wired to API |
| Core KPIs | Sales, volume, GM — SAP-backed where handlers complete |
| Speed / shipping days | `GET /api/speed` |
| AR / customers / inventory (scoped) | Per `_scope.js` + handler tests |
| Admin portal | `pg-admin-team.html` — upsert / reset PIN / remove user (exec paths) |
| Silence / unsilence | Post endpoints with session |

## Beta — functional but incomplete UX or data

| Surface | Caveat |
|---------|--------|
| **Budget & P&L** (`pg-budget`) | Wired to `/api/budget`; some targets/charts remain prototype — validate numbers before executive decisions |
| **Sales Pivot** | Depends on pivot dimensions — confirm filters match finance definitions |
| **Customer Plotting** | Chart + data plumbing — verify sample vs production expectations |
| **Itemized Sales** | District / national modes — confirm mapping labels vs SAP |
| **Team hierarchy** tables | Deep hierarchy may need SAP manager-chain completeness |

## Explicit non-goals for this Beta tag

- Full **self-service** PIN recovery without admin
- **Patrol** offline shell (separate app)
- Replacing SAP as source of truth

## Labeling recommendation

Add a small **“Beta”** chip in nav or footer for pages in the middle section until stakeholders sign off row-by-row.

---

*Last updated: 2026-05-03*
