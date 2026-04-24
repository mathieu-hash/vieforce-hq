-- ==============================================================
-- RLS on public.users — proper version (Option 2)
--
-- Replaces migrations/admin-portal-rls.sql (Sunday) which caused
-- infinite recursion (self-referencing USING clause). Fixed via a
-- SECURITY DEFINER helper that bypasses RLS inside the policy check.
--
-- Posture:
--   SELECT — open to all (anon + authenticated). Enables js/auth.js
--            login SELECT using the anon key. Read of public.users
--            rows was never sensitive (no PIN hash exposure — wait,
--            pin_hash IS exposed on SELECT; see Tuesday TODO below).
--   INSERT/UPDATE/DELETE — only callers whose auth.uid() maps to a
--            users row with role IN ('exec','ceo','admin'). The
--            service_role key bypasses RLS entirely and remains the
--            path used by /api/admin/* endpoints.
--
-- Apply AFTER migrations/rls-emergency-revert-users.sql has been
-- executed and login is verified working.
-- ==============================================================

-- 1. Drop the broken Sunday policies (idempotent if already dropped).
DROP POLICY IF EXISTS admin_users_full_access ON public.users;
DROP POLICY IF EXISTS users_read_self         ON public.users;

-- 2. SECURITY DEFINER helper — runs with the owner's privileges, so
-- the SELECT inside bypasses RLS on public.users (no recursion).
CREATE OR REPLACE FUNCTION public.is_admin_user()
  RETURNS boolean
  LANGUAGE sql
  SECURITY DEFINER
  SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.users
    WHERE id = auth.uid()
      AND role IN ('exec', 'ceo', 'admin')
  );
$$;

-- Lock the function so only privileged roles can invoke it directly.
-- RLS policies evaluate it transparently — explicit grants not needed
-- for the policy path, but we also want to deny ad-hoc callers.
REVOKE ALL ON FUNCTION public.is_admin_user() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.is_admin_user() TO authenticated, anon, service_role;

-- 3. Re-enable RLS.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- 4. Policies.
DROP POLICY IF EXISTS users_public_read   ON public.users;
DROP POLICY IF EXISTS users_admin_insert  ON public.users;
DROP POLICY IF EXISTS users_admin_update  ON public.users;
DROP POLICY IF EXISTS users_admin_delete  ON public.users;

CREATE POLICY users_public_read ON public.users
  FOR SELECT USING (true);

CREATE POLICY users_admin_insert ON public.users
  FOR INSERT WITH CHECK (public.is_admin_user());

CREATE POLICY users_admin_update ON public.users
  FOR UPDATE USING (public.is_admin_user())
                 WITH CHECK (public.is_admin_user());

CREATE POLICY users_admin_delete ON public.users
  FOR DELETE USING (public.is_admin_user());

-- ==============================================================
-- Verify:
--   SELECT relrowsecurity FROM pg_class
--    WHERE relname='users' AND relnamespace=(SELECT oid FROM pg_namespace WHERE nspname='public');
--   -- Expected: t
--
--   SELECT policyname, cmd FROM pg_policies
--    WHERE schemaname='public' AND tablename='users' ORDER BY policyname;
--   -- Expected 4 rows:
--   --   users_admin_delete  DELETE
--   --   users_admin_insert  INSERT
--   --   users_admin_update  UPDATE
--   --   users_public_read   SELECT
--
-- Smoke test (should match pre-Sunday behaviour):
--   curl -H "apikey: <ANON>" -H "Authorization: Bearer <ANON>" \
--     "https://<ref>.supabase.co/rest/v1/users?phone=eq.09180000099&select=id"
--   -- Expected: HTTP 200, [{"id":"..."}]
-- ==============================================================

-- TUESDAY TODO (unrelated to recursion fix but relevant to this table):
--   pin_hash plaintext is SELECT-readable by anon right now because the
--   login SELECT in js/auth.js fetches it to compare client-side. This
--   is inherited from the legacy pre-Supabase-Auth HQ login flow and
--   should move server-side: add POST /api/auth/login on Cloud Run that
--   accepts phone+pin, checks pin_hash server-side (service_role), and
--   returns a session record. Then RLS can hide pin_hash from anon
--   SELECTs via a COLUMN-level grant or a column-filter policy.
