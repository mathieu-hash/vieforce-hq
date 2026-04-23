-- ==============================================================
-- VieForce HQ — Admin Portal schema prep
-- Migration: ensure public.users has hierarchy audit columns and
--            a role CHECK constraint that includes 'director'.
-- Idempotent — safe to run multiple times.
-- ==============================================================

-- 1. Audit columns (added ADD IF NOT EXISTS to avoid errors if
--    sprint-b-hierarchy.sql already added them on Saturday).
ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS hierarchy_updated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS hierarchy_updated_by UUID REFERENCES public.users(id);

-- 2. Role whitelist — DROP + CREATE ensures 'director' is included even if
--    a previous constraint allowed only the legacy 4 roles.
ALTER TABLE public.users
  DROP CONSTRAINT IF EXISTS users_role_check;

ALTER TABLE public.users
  ADD CONSTRAINT users_role_check
  CHECK (role IN ('tsr','dsm','rsm','director','exec','ceo'));

-- 3. Useful index for the admin portal lookup (sap_slpcode is the key the
--    /api/admin/upsert-user endpoint uses to decide insert-vs-update).
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sap_slpcode
  ON public.users (sap_slpcode)
  WHERE sap_slpcode IS NOT NULL;

-- ==============================================================
-- Verify:
--   SELECT column_name FROM information_schema.columns
--     WHERE table_schema='public' AND table_name='users'
--       AND column_name LIKE 'hierarchy_%';
--   -- Expected: hierarchy_updated_at, hierarchy_updated_by
--
--   SELECT pg_get_constraintdef(oid) FROM pg_constraint
--     WHERE conname='users_role_check';
--   -- Expected: CHECK (...('tsr','dsm','rsm','director','exec','ceo'))
-- ==============================================================
