-- ==============================================================
-- VieForce HQ — Admin Portal prep
-- Migration: delete 5 fake/placeholder test users
-- Run ONCE in Supabase SQL Editor (not via app code).
--
-- Why: the 5 fakes have no real SAP identity. Real-SAP onboarding
-- happens via /pg-admin-team.html after this runs. Mat's row
-- (SlpCode 2, phone 09180000099) is preserved.
-- ==============================================================

-- Delete auth.users rows first (FK dependency from public.users.id → auth.users.id).
-- Matched via the public.users.phone index so we don't need to hardcode UUIDs.
DELETE FROM auth.users WHERE id IN (
  SELECT id FROM public.users WHERE phone IN (
    '09180000010',  -- Rina Morales
    '09180000001',  -- Jefrey Florentino
    '09180000002',  -- Marvin Dela Cruz
    '09170000001',  -- Rico Abante
    '09170000002'   -- Jake Santos
  )
);

DELETE FROM public.users WHERE phone IN (
  '09180000010',
  '09180000001',
  '09180000002',
  '09170000001',
  '09170000002'
);

-- ==============================================================
-- Verify (expected counts after run):
--   SELECT COUNT(*) FROM public.users WHERE phone IN
--     ('09180000010','09180000001','09180000002','09170000001','09170000002');
--   -- Expected: 0
--
--   SELECT COUNT(*) FROM public.users WHERE phone = '09180000099';
--   -- Expected: 1  (Mat's row intact)
--
--   SELECT COUNT(*) FROM auth.users
--   WHERE id IN (SELECT id FROM public.users WHERE sap_slpcode IS NULL);
--   -- Expected: low (after onboarding all 43 active OSLP reps via portal,
--   --  only legacy non-SAP accounts should remain without slpcode)
-- ==============================================================
