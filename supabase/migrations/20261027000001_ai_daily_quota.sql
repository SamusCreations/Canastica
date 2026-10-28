-- ============================================================================
-- Daily AI quota per account
-- The "assistant" Edge Function calls consume_ai_quota() (as the signed-in user)
-- before every AI request and release_ai_quota() (service role) when the request
-- fails, so failures do not cost the user. Days follow Costa Rica time.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.ai_usage (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  day DATE NOT NULL,
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, day)
);

-- RLS on and no policies: users cannot read or write rows directly, only through the functions below
ALTER TABLE public.ai_usage ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.ai_quota_today()
RETURNS DATE
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (NOW() AT TIME ZONE 'America/Costa_Rica')::date;
$$;

-- Atomically takes one unit for auth.uid() if there is room under p_limit
CREATE OR REPLACE FUNCTION public.consume_ai_quota(p_limit INTEGER)
RETURNS TABLE (allowed BOOLEAN, used INTEGER, remaining INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user UUID := auth.uid();
  v_day DATE := public.ai_quota_today();
  v_count INTEGER;
BEGIN
  IF v_user IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  INSERT INTO public.ai_usage (user_id, day, count)
  VALUES (v_user, v_day, 0)
  ON CONFLICT (user_id, day) DO NOTHING;

  UPDATE public.ai_usage
     SET count = count + 1, updated_at = NOW()
   WHERE user_id = v_user AND day = v_day AND count < p_limit
  RETURNING count INTO v_count;

  IF v_count IS NULL THEN
    SELECT u.count INTO v_count FROM public.ai_usage u WHERE u.user_id = v_user AND u.day = v_day;
    RETURN QUERY SELECT FALSE, v_count, GREATEST(p_limit - v_count, 0);
  ELSE
    RETURN QUERY SELECT TRUE, v_count, GREATEST(p_limit - v_count, 0);
  END IF;
END;
$$;

-- Read-only: how much of today's quota auth.uid() has used
CREATE OR REPLACE FUNCTION public.get_ai_quota(p_limit INTEGER)
RETURNS TABLE (used INTEGER, remaining INTEGER)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(u.count, 0), GREATEST(p_limit - COALESCE(u.count, 0), 0)
  FROM (SELECT 1) AS one
  LEFT JOIN public.ai_usage u
    ON u.user_id = auth.uid() AND u.day = public.ai_quota_today();
$$;

-- Gives one unit back after a failed AI request. Service role only, so users cannot reset their quota.
CREATE OR REPLACE FUNCTION public.release_ai_quota(p_user_id UUID)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE public.ai_usage
     SET count = GREATEST(count - 1, 0), updated_at = NOW()
   WHERE user_id = p_user_id AND day = public.ai_quota_today();
$$;

REVOKE ALL ON FUNCTION public.consume_ai_quota(INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.get_ai_quota(INTEGER) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.release_ai_quota(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_ai_quota(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_ai_quota(INTEGER) TO authenticated;
GRANT EXECUTE ON FUNCTION public.release_ai_quota(UUID) TO service_role;
