-- ============================================================================
-- "Facturas por correo": each household gets facturas+<code>@<domain>.
-- Resend Inbound calls the `inbound-invoice` Edge Function, which stores the
-- XML / PDF in the private bucket `inbound-invoices` (<household_id>/<id>.<ext>)
-- and a row in inbound_invoices. Members review them in the app.
-- ============================================================================

-- Future paid plans; 'free' for everyone today
ALTER TABLE public.households
  ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free', 'plus'));

CREATE TABLE IF NOT EXISTS public.invoice_mailboxes (
  household_id UUID PRIMARY KEY REFERENCES public.households(id) ON DELETE CASCADE,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9]{8,16}$'),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  auto_import BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE public.invoice_mailboxes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members manage their invoice mailbox" ON public.invoice_mailboxes;
CREATE POLICY "Members manage their invoice mailbox"
  ON public.invoice_mailboxes FOR ALL
  USING (public.is_household_member(household_id))
  WITH CHECK (public.is_household_member(household_id));

CREATE TABLE IF NOT EXISTS public.inbound_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  sender TEXT,
  subject TEXT,
  clave TEXT,                       -- Hacienda 50-digit key, used to spot duplicates
  issuer TEXT,
  total NUMERIC(12, 2),
  issued_at DATE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'imported', 'rejected', 'duplicate', 'error', 'confirmation')),
  error_detail TEXT,
  confirmation_code TEXT,           -- Gmail forwarding confirmation code
  xml_path TEXT,
  pdf_path TEXT,
  purchase_id UUID REFERENCES public.purchases(id) ON DELETE SET NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS inbound_invoices_household_idx ON public.inbound_invoices (household_id, received_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS inbound_invoices_clave_unique
  ON public.inbound_invoices (household_id, clave)
  WHERE clave IS NOT NULL AND status <> 'duplicate';

ALTER TABLE public.inbound_invoices ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read inbound invoices" ON public.inbound_invoices;
CREATE POLICY "Members read inbound invoices"
  ON public.inbound_invoices FOR SELECT
  USING (public.is_household_member(household_id));

DROP POLICY IF EXISTS "Members review inbound invoices" ON public.inbound_invoices;
CREATE POLICY "Members review inbound invoices"
  ON public.inbound_invoices FOR UPDATE
  USING (public.is_household_member(household_id))
  WITH CHECK (public.is_household_member(household_id));

DROP POLICY IF EXISTS "Members delete inbound invoices" ON public.inbound_invoices;
CREATE POLICY "Members delete inbound invoices"
  ON public.inbound_invoices FOR DELETE
  USING (public.is_household_member(household_id));
-- No INSERT policy: only the Edge Function (service role) creates rows

INSERT INTO storage.buckets (id, name, public)
VALUES ('inbound-invoices', 'inbound-invoices', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Household members can read inbound invoice files" ON storage.objects;
CREATE POLICY "Household members can read inbound invoice files"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'inbound-invoices'
    AND public.is_household_member((storage.foldername(name))[1]::uuid)
  );

-- Daily clean-up of old attachments (reviewed more than 90 days ago), through the same function
CREATE OR REPLACE FUNCTION public.invoke_edge_function(p_function TEXT, p_body JSONB)
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
    RAISE WARNING 'canastica: missing vault secrets canastica_functions_url / canastica_cron_secret';
    RETURN;
  END IF;
  PERFORM net.http_post(
    url := rtrim(v_url, '/') || '/' || p_function,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    body := p_body,
    timeout_milliseconds := 60000
  );
END;
$$;

REVOKE ALL ON FUNCTION public.invoke_edge_function(TEXT, JSONB) FROM PUBLIC, anon, authenticated;

SELECT cron.schedule('canastica-inbound-cleanup', '30 9 * * *',
  $$SELECT public.invoke_edge_function('inbound-invoice', '{"action":"cleanup"}'::jsonb)$$);
