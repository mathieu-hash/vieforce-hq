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
| **Patrol (`vieforce-patrol`)** | **Acknowledged.** The VieForce Patrol track accepts this document as the working integration contract: server-side calls use `Authorization: Bearer <HQ_SERVICE_TOKEN>`; territory-scoped SAP reads use `scope=user:<supabase_user_uuid>`; additive vs semantic changes follow the breaking-change protocol above; Patrol mobile does not rely on `GET /api/diag` (diag remains server/diagnostics only per HQ env). | 2026-05-01 |

*HQ row recorded 2026-05-03; Patrol row recorded 2026-05-01 (Patrol session). Both tracks binding for coordinated changes.*

### Patrol track sign-off (detail)

Patrol maintainers confirm in substance:

- **S2S auth:** `Authorization: Bearer <HQ_SERVICE_TOKEN>` for Patrol → HQ.  
- **Territory scope:** `scope=user:<supabase_user_uuid>` for scoped SAP reads (aligned with HQ `api/_scope.js`).  
- **Change discipline:** additive vs semantic changes per protocol above; coordinate and update Patrol tests / CHANGELOG when behavior or response shapes break.  
- **Diagnostics:** `GET /api/diag` is **not** part of the mobile contract; HQ-side / diagnostics only when explicitly allowed by HQ env.

*Patrol mirror:* [`vieforce-patrol` → `docs/HQ_API_CONTRACT.md`](https://github.com/mathieu-hash/vieforce-patrol/blob/main/docs/HQ_API_CONTRACT.md) points here.

---

*Last updated: 2026-05-03*
