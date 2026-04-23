-- ==============================================================
-- VieForce HQ — Admin Portal RLS policies on public.users
-- Mirrors the district_mappings pattern (exec/ceo have full access).
-- Service-role key bypasses RLS automatically, so backend writes via
-- the service_role client continue to work for S2S/admin endpoints.
-- ==============================================================

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- Full-access for exec/ceo (idempotent via DROP+CREATE).
DROP POLICY IF EXISTS admin_users_full_access ON public.users;
CREATE POLICY admin_users_full_access ON public.users
  FOR ALL
  USING (EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role IN ('exec','ceo')
  ))
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid() AND role IN ('exec','ceo')
  ));

-- Read-self for everyone (authenticated users read their own row).
DROP POLICY IF EXISTS users_read_self ON public.users;
CREATE POLICY users_read_self ON public.users
  FOR SELECT
  USING (id = auth.uid());

-- ==============================================================
-- Verify:
--   SELECT policyname, cmd FROM pg_policies
--     WHERE schemaname='public' AND tablename='users'
--     ORDER BY policyname;
--   -- Expected: admin_users_full_access (ALL), users_read_self (SELECT)
--
--   SELECT relrowsecurity FROM pg_class WHERE relname='users';
--   -- Expected: t
-- ==============================================================
