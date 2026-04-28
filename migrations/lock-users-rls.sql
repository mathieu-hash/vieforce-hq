-- Lock down public.users so anon key cannot read pin_hash anymore.
-- Apply AFTER /api/auth/login is deployed and js/auth.js calls it (otherwise login breaks).
--
-- Pre-conditions:
--   1. Cloud Run vieforce-hq-api has been redeployed with the new auth/login endpoint
--   2. Vercel vieforce-hq has been redeployed with the new js/auth.js that calls the endpoint
--   3. You've smoke-tested login from a fresh browser session and confirmed it works
--
-- Run this in the Supabase SQL editor for project yolxcmeoovztuindrglk.

BEGIN;

-- 1. Make sure RLS is on
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;

-- 2. Drop any permissive existing policies on users (we want service_role-only access)
--    Add or remove names below if the SELECT in pg_policies shows other policy names.
DROP POLICY IF EXISTS "Allow anon read users" ON public.users;
DROP POLICY IF EXISTS "Public read for login" ON public.users;
DROP POLICY IF EXISTS "anon_can_select" ON public.users;
DROP POLICY IF EXISTS "users_anon_select" ON public.users;

-- 3. Verify state — should return 0 rows when run as anon (because no policy permits)
--    Don't run as part of the migration; do it manually after to confirm:
--    SELECT * FROM public.users LIMIT 1;   -- as anon → should return 0 or permission denied
--
-- service_role bypasses RLS, so the new /api/auth/login endpoint (which uses service-role)
-- continues to work.

COMMIT;

-- Audit query (run separately):
-- SELECT polname, polcmd, polroles::regrole[], polqual::text
-- FROM pg_policy WHERE polrelid = 'public.users'::regclass;
