---
status: testing
phase: 04-beta-uat
source: ADMIN_VALIDATION_CHECKLIST.md, ROADMAP.md (Phases 3–4)
started: 2026-05-03T12:15:00Z
updated: 2026-05-03T12:15:00Z
---

## Current Test

number: 1
name: Staging preconditions (env + session)
expected: |
  On the **staging** API you will use for admin UAT: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, and SAP-related env vars are set on the runtime. In the browser you have an **exec** or **ceo** session open on `pg-admin-team.html` (or the same admin surface you use for team management) against that API. Test phone numbers are **not** production exec phones unless you have explicitly agreed to that risk.
awaiting: user response

## Tests

### 1. Staging preconditions (env + session)
expected: Staging API has Supabase + SAP env configured; exec/ceo admin UI session; safe test phones only.
result: [pending]

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

### 7. A6 — Non-exec cannot upsert
expected: A non-exec / unprivileged session calling the admin upsert (or equivalent) gets **403 or 401**, not success.
result: [pending]

## Summary

total: 7
passed: 0
issues: 0
pending: 7
skipped: 0
blocked: 0

## Gaps

[none yet]
