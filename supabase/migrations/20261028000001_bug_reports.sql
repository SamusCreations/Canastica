-- ============================================================================
-- Problem reports sent from the app ("Reportar un problema")
-- Written and read only by the "assistant" Edge Function with the service role,
-- which also emails them to the admin. RLS is on and there are no policies, so
-- users cannot read, list or change reports through the API.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.bug_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  user_email TEXT,
  household_id UUID REFERENCES public.households(id) ON DELETE SET NULL,
  description TEXT NOT NULL CHECK (char_length(description) BETWEEN 1 AND 4000),
  screen TEXT,
  context JSONB NOT NULL DEFAULT '{}'::jsonb,
  screenshot_path TEXT,
  email_status TEXT NOT NULL DEFAULT 'pending' CHECK (email_status IN ('pending', 'sent', 'failed', 'not_configured')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS bug_reports_user_created_idx
  ON public.bug_reports (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS bug_reports_created_idx
  ON public.bug_reports (created_at DESC);

ALTER TABLE public.bug_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bug_reports FROM anon, authenticated;

-- Private bucket for report screenshots (no storage policies: only the service role touches it)
INSERT INTO storage.buckets (id, name, public)
VALUES ('bug-reports', 'bug-reports', false)
ON CONFLICT (id) DO NOTHING;
