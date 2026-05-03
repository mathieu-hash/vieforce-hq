# Admin portal validation — staging checklist (PROD-02)

Run against **staging** Supabase + SAP connectivity (or dry-run with test users only). Check each box when verified.

## Preconditions

- [ ] `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`, SAP vars set on API runtime  
- [ ] Logged in as **exec** or **ceo** session in `pg-admin-team.html`  
- [ ] Test phone numbers are **not** production exec phones unless agreed  

## Flows

| Step | Action | Pass criteria |
|------|--------|----------------|
| A1 | Open SAP reps list | `/api/admin/sap-reps` returns rep rows |
| A2 | Upsert new test user (non-prod phone) | 200; row appears in Supabase `auth.users` + `public.users` |
| A3 | Upsert same user with role change | 200; profile updates |
| A4 | Reset PIN for test user | 200; login works with new PIN via `/api/auth/login` |
| A5 | Remove test user | 200; user cannot login; rows cleaned per handler semantics |
| A6 | Negative: non-exec session calls upsert | 403/401 as designed |

## Evidence

Paste **commit SHA + date** and operator name when this checklist completes for Beta sign-off.

---

*Template — 2026-05-03*
