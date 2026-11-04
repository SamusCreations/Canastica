-- ============================================================================
-- Weekly / monthly summary and daily "about to run out" push.
-- pg_cron calls the `summary` Edge Function through pg_net. The function URL and
-- the shared secret live in Supabase Vault (never in this file):
--   select vault.create_secret('https://<ref>.supabase.co/functions/v1', 'canastica_functions_url');
--   select vault.create_secret('<same value as the CRON_SECRET function secret>', 'canastica_cron_secret');
-- Times are UTC; Costa Rica is UTC-6.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS pg_net;

ALTER TABLE public.notification_preferences
  ADD COLUMN IF NOT EXISTS summary_frequency TEXT NOT NULL DEFAULT 'weekly'
    CHECK (summary_frequency IN ('weekly', 'monthly', 'none')),
  ADD COLUMN IF NOT EXISTS summary_email BOOLEAN NOT NULL DEFAULT FALSE;

CREATE OR REPLACE FUNCTION public.invoke_summary_function(p_period TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_url TEXT;
  v_secret TEXT;
BEGIN
  SELECT decrypted_secret INTO v_url FROM vault.decrypted_secrets WHERE name = 'canastica_functions_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'canastica_cron_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN
    RAISE WARNING 'canastica summary: missing vault secrets canastica_functions_url / canastica_cron_secret';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := rtrim(v_url, '/') || '/summary',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := jsonb_build_object('period', p_period),
    timeout_milliseconds := 60000
  );
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_summary_function(TEXT) FROM PUBLIC, anon, authenticated;

-- Monday 6:00 CR: weekly summary
SELECT cron.schedule('canastica-summary-weekly', '0 12 * * 1', $$SELECT public.invoke_summary_function('weekly')$$);
-- Day 1, 6:00 CR: monthly summary
SELECT cron.schedule('canastica-summary-monthly', '0 12 1 * *', $$SELECT public.invoke_summary_function('monthly')$$);
-- Every day 7:00 CR: products about to run out
SELECT cron.schedule('canastica-restock-push', '0 13 * * *', $$SELECT public.invoke_summary_function('daily')$$);
