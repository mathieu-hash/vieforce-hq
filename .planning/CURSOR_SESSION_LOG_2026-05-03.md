# Cursor session log — resume here (2026-05-03)

Use this file to pick up **Patrol ↔ HQ ↔ SAP ↔ MCP** work and **GSD Beta UAT** without re-reading long chats.

---

## GSD phasing / milestone (VieForce HQ)

| Item | Location |
|------|----------|
| Milestone | **v1.0 Beta** — HQ Desktop deployment-ready |
| Live state | `.planning/STATE.md` — `status: ready-for-uat` |
| Roadmap (phases 1–4 closed in-repo) | `.planning/ROADMAP.md` |
| Requirements checklist | `.planning/REQUIREMENTS.md` |
| **UAT checkpoint (where we left execution)** | `.planning/phases/04-beta-uat/4-UAT.md` |

**Stopped at (2026-05-03):** Phase **04-beta-uat** — `4-UAT.md` lists **Test 2: A1 — SAP reps list** as **`result: [pending]`** (awaiting user response after staging preconditions marked pass).

**Suggested next GSD commands when resuming:**

1. Open `.planning/phases/04-beta-uat/4-UAT.md` — continue from **A1 SAP reps list** (then A2, A3, … per `ADMIN_VALIDATION_CHECKLIST.md`).
2. `/gsd-verify-work` or manual walk of `.planning/ADMIN_VALIDATION_CHECKLIST.md`
3. When sign-off is real: `/gsd-audit-milestone` → `/gsd-complete-milestone`

---

## Patrol — Sales tab / scope (engineering facts)

- **Path:** Browser → Patrol Vercel `/api/sap/sales` → HQ Cloud Run `/api/sales` → SAP (not direct SQL from browser).
- **Scope:** HQ `api/_scope.js` — DSM = union(TSR `sap_slpcode` under manager) **plus** DSM own `sap_slpcode`; empty if no SLPs and no district.
- **Patrol UX / docs:** `vieforce-patrol` — `api/sap/README.md` troubleshooting; `js/sales-tab.js` empty-state copy (v bumped in `app.html`).
- **Vercel (Patrol) env present (names only):** `HQ_SERVICE_TOKEN`, `HQ_API_BASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` (Production). **Parity:** compare token string **Vercel ↔ Cloud Run** once; rotate both together if unsure.

---

## Supabase — user mapping (2026-05-03)

| Subject | Note |
|---------|------|
| **Marvin Dela Cruz** (DSM) | `sap_slpcode` + `sap_district_code` both **null**, no TSRs → HQ **`is_empty`** until real **OSLP** / district from SAP (no guessing). |
| **WINDEL OLIVA** (DSM) | `sap_slpcode` **41** → scope **not** empty from mapping; zeros on Sales → SAP volume / SLP 41 vs invoices, not Patrol “empty state.” |
| **Demo TSR Alpha/Beta/Gamma** | **Reverted:** `sap_slpcode` **NULL**, **`manager_id` NULL** (detached from Windel) — avoids three demo identities sharing production SLP 41. |

---

## SAP MCP (`user-mssql-sap-b1`) — connection / Cursor

- Connection string is read from **`~/.claude/settings.json`** via the PowerShell MCP wrapper; **Cursor loads at MCP process start** (not hot-reloaded).
- After **`gsheet`** password fix in `settings.json`: **Cursor → Command Palette → `MCP: Restart MCP Servers`** (or full quit/reopen Cursor).
- Smoke query after restart: `SELECT TOP 1 CardCode, CardName FROM OCRD`
- **VPN:** MCP runs locally with Cursor; **Azure VPN** on the laptop routes `analytics.vienovo.ph:4444` automatically — no separate MCP VPN toggle.
- If login still fails after restart + VPN: **SQL Server password** for `gsheet` may need DBA reset to match `settings.json`.

**Last automated check from a Cursor agent session (may be stale MCP cache):** `test_connection` → `Login failed for user 'gsheet'.` — **re-run after MCP restart** to validate the fix.

---

## Related audit artifact

- `.planning/AUDIT_HQ_PATROL_2026-05-03.md` — if present, cross-check with this log.

---

## How to update this log

Append a dated section when closing a session, or move superseded bullets to an archive file under `.planning/archive/` if the repo grows noisy.
