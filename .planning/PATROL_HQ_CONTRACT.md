# Patrol ↔ HQ API contract (INT-01)

**Consumers:** `vieforce-patrol` mobile app and backend proxies calling **VieForce HQ API**.

## Authentication

| Mechanism | Header | When |
|-----------|--------|------|
| Field user scope | `Authorization: Bearer <HQ_SERVICE_TOKEN>` | Server-side Patrol → HQ |
| Optional scope query | `scope=user:<supabase_user_uuid>` | Restrict SAP rows to that user’s territory (`api/_scope.js`) |

**HQ_SERVICE_TOKEN** must match Cloud Run / local `.env` — rotate via shared secret store.

## Breaking-change protocol

1. **Additive changes** (new optional query params, new JSON fields): OK without Patrol bump if ignored safely.  
2. **Semantic changes** (filter logic, status codes, shape removals): **coordinate** — bump Patrol minor version + note in Patrol CHANGELOG; test Patrol unit tests (`hq-client`, scope tests).  
3. **Emergency security fix on HQ:** Patrol may need redeploy if behavior contract changes; notify Patrol owner same day.

## Endpoints Patrol relies on (non-exhaustive)

Derived from Patrol repo tests and HQ handlers — keep stable:

- Sales / AR / inventory / speed / customers — typically with `scope=user:…`  
- Admin routes generally **not** called from Patrol mobile UX  

## Diagnostics

- `GET /api/diag` — **not** for Patrol mobile clients; optional server-to-server only if `DIAG_ALLOW_SERVICE_TOKEN=1` on HQ.

---

## Acknowledgment

| Track | Statement | Date |
|-------|-----------|------|
| **HQ (`vieforce-hq`)** | **Acknowledged.** The VieForce HQ codebase and API maintainers accept this document as the working contract for Patrol integration: `HQ_SERVICE_TOKEN` for S2S auth, `scope=user:<uuid>` for territory-scoped SAP reads, breaking-change protocol above, and no reliance on `/api/diag` from mobile. | 2026-05-03 |
| **Patrol (`vieforce-patrol`)** | *Recommended:* Patrol owner adds a one-line confirmation (PR comment, issue, or edit to this table) when the mobile track has read and agrees. | — |

*Recorded at user request via Cursor; HQ side treated as binding for future HQ changes affecting Patrol.*

---

*Last updated: 2026-05-03*
