-- ==============================================================
-- VieForce HQ — Silence System
-- Migration: create `silenced_alerts` table
-- Run this once in Supabase SQL Editor (or via Supabase CLI).
-- ==============================================================

-- 1. Table
CREATE TABLE IF NOT EXISTS public.silenced_alerts (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  alert_type      TEXT        NOT NULL,
    -- one of: 'rescue','grow','warning','legacy_ar',
    --        'margin_critical','margin_warning','dormant_active'
  customer_code   TEXT        NOT NULL,
  customer_name   TEXT,       -- denormalised snapshot for drawer display (optional)
  silenced_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  silenced_until  TIMESTAMPTZ,-- NULL = forever
  note            TEXT,
  active          BOOLEAN     NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 2. Type constraint (soft — allow future alert types without schema migrations)
ALTER TABLE public.silenced_alerts
  DROP CONSTRAINT IF EXISTS silenced_alerts_alert_type_check;
ALTER TABLE public.silenced_alerts
  ADD CONSTRAINT silenced_alerts_alert_type_check
  CHECK (alert_type IN (
    'rescue', 'grow', 'warning', 'legacy_ar',
    'margin_critical', 'margin_warning', 'dormant_active'
  ));

-- 3. Partial index on active silences (fast lookup for filter)
CREATE INDEX IF NOT EXISTS idx_silenced_active
  ON public.silenced_alerts (user_id, alert_type, customer_code)
  WHERE active = true
    AND (silenced_until IS NULL OR silenced_until > NOW());

-- 4. Auto-expiry view (optional — useful for reporting)
CREATE OR REPLACE VIEW public.silenced_alerts_current AS
SELECT *
FROM public.silenced_alerts
WHERE active = true
  AND (silenced_until IS NULL OR silenced_until > NOW());

-- 5. RLS policy — matches existing `users` table pattern (RLS OFF for
-- internal tool; auth is enforced by our backend session verification).
-- If you later enable RLS, the following policy is equivalent:
--
--   ALTER TABLE public.silenced_alerts ENABLE ROW LEVEL SECURITY;
--   CREATE POLICY "silenced_alerts_all"
--     ON public.silenced_alerts FOR ALL
--     USING (true) WITH CHECK (true);
--
-- For now, leave RLS DISABLED (same as `users`). Backend auth is the gate.
ALTER TABLE public.silenced_alerts DISABLE ROW LEVEL SECURITY;

-- 6. Grants (anon key used by backend must be able to select/insert/update)
GRANT SELECT, INSERT, UPDATE ON public.silenced_alerts TO anon, authenticated, service_role;
GRANT SELECT ON public.silenced_alerts_current       TO anon, authenticated, service_role;

-- ==============================================================
-- Verify:
--   SELECT COUNT(*) FROM public.silenced_alerts;                -- 0
--   SELECT indexname FROM pg_indexes
--     WHERE tablename = 'silenced_alerts';                      -- idx_silenced_active
--
-- Rollback:
--   DROP VIEW  IF EXISTS public.silenced_alerts_current;
--   DROP TABLE IF EXISTS public.silenced_alerts;
-- ==============================================================
