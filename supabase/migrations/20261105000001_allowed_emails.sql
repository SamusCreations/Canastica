-- ============================================================================
-- Access allowlist: only approved emails can create a Canastica account.
-- Enforced in the database (trigger on auth.users), so it holds no matter how
-- the sign-up arrives (Google, email, magic link).
-- Manage it from the Supabase dashboard (Table Editor > allowed_emails) or SQL:
--   insert into public.allowed_emails (email) values ('persona@gmail.com');
--   delete from public.allowed_emails where email = 'persona@gmail.com';
-- Existing accounts keep working; the check only runs when a new account is created.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.allowed_emails (
  email TEXT PRIMARY KEY CHECK (email = lower(btrim(email))),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Nobody reads or writes it from the app; only the dashboard / service role
ALTER TABLE public.allowed_emails ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.allowed_emails FROM anon, authenticated;

-- Everyone who already has an account stays approved
INSERT INTO public.allowed_emails (email, note)
SELECT DISTINCT lower(btrim(email)), 'cuenta existente'
FROM auth.users
WHERE email IS NOT NULL AND btrim(email) <> ''
ON CONFLICT (email) DO NOTHING;

CREATE OR REPLACE FUNCTION public.enforce_allowed_email()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.email IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.allowed_emails WHERE email = lower(btrim(NEW.email))
  ) THEN
    RAISE EXCEPTION 'email_not_allowed' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_allowed_email() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS enforce_allowed_email ON auth.users;
CREATE TRIGGER enforce_allowed_email
  BEFORE INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.enforce_allowed_email();
