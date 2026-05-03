---
status: testing
phase: 04-beta-uat
source: ADMIN_VALIDATION_CHECKLIST.md, ROADMAP.md (Phases 3–4)
started: 2026-05-03T12:15:00Z
updated: 2026-05-03T12:45:00Z
---

## Current Test

number: 2
name: A1 — SAP reps list
expected: |
  As an authorized user managing the team (CEO, evp / EV Sales, marketing / Marketing Manager, admin / Sales Admin, or service token — not `exec`), loading or calling `/api/admin/sap-reps` returns SAP rep rows consistent with your staging SAP data (not an auth error).
awaiting: user response

## Stakeholder notes (2026-05-03)

- **User management page:** **CEO**, **evp** (EV Sales), **marketing** (Marketing Manager), **admin** (Sales Admin); **`exec` excluded** from admin portal by policy. `marketing` upsert in `api/admin/upsert-user.js`; matrix `.planning/AUTHZ_MATRIX.md`.

## Tests

### 1. Staging preconditions (env + session)
expected: Staging API has Supabase + SAP env configured; user-admin UI session (ceo / evp / marketing / admin); safe test phones only.
result: pass

### 2. A1 — SAP reps list
expected: As authorized admin, `/api/admin/sap-reps` returns SAP rep rows (matches your staging SAP data).
result: [pending]

### 3. A2 — Upsert new test user
expected: Creating/updating a test user (non-prod phone) returns 200; row appears in Supabase `auth.users` and `public.users` as designed.
result: [pending]

### 4. A3 — Role change on existing user
expected: Upserting the same user with a changed role returns 200; profile reflects the new role.
result: [pending]

### 5. A4 — Reset PIN
expected: Reset-PIN for the test user returns 200; `/api/auth/login` works with the new PIN.
result: [pending]

### 6. A5 — Remove test user
expected: Remove returns 200; user can no longer log in; rows cleaned per API semantics.
result: [pending]

### 7. A6 — Non–user-admin roles cannot manage users
expected: Sessions with **field roles** (e.g. **tsr**, **dsm**, **rsm**) or **`exec`** (non-CEO executive) calling admin upsert or `/api/admin/sap-reps` get **403** (or **401** if unauthenticated), not success.
result: [pending]

## Summary

total: 7
passed: 1
issues: 0
pending: 6
skipped: 0
blocked: 0

## Gaps

[none yet]
