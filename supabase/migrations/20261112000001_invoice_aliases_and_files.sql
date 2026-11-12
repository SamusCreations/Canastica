-- ============================================================================
-- Facturas por correo, round 2:
-- 1. Readable address per household: <alias>@<domain> (e.g. rodriguez@facturas.canastica.app),
--    unique across the whole app, so it can be dictated at a store's checkout.
--    The old facturas+<code>@ address keeps working.
-- 2. Each received email keeps the invoice XML, Hacienda's response XML and the PDF,
--    and records whether the set was complete (only complete, accepted sets are imported
--    automatically).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Aliases
-- ---------------------------------------------------------------------------
-- alias_key = alias without hyphens: "rodriguez-heredia" and "rodriguezheredia" are the same
-- address, so a cashier who drops the hyphen still reaches the right household, and nobody
-- can register a look-alike. A replaced alias keeps working (and stays reserved) for 30 days.
CREATE TABLE IF NOT EXISTS public.invoice_mailbox_aliases (
  alias_key TEXT PRIMARY KEY CHECK (alias_key ~ '^[a-z0-9]{3,30}$'),
  alias TEXT NOT NULL CHECK (alias ~ '^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$' AND alias !~ '--'),
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ            -- NULL = the household's current alias
);

CREATE UNIQUE INDEX IF NOT EXISTS invoice_mailbox_aliases_current
  ON public.invoice_mailbox_aliases (household_id) WHERE expires_at IS NULL;
CREATE INDEX IF NOT EXISTS invoice_mailbox_aliases_household_idx
  ON public.invoice_mailbox_aliases (household_id);

ALTER TABLE public.invoice_mailbox_aliases ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read their invoice aliases" ON public.invoice_mailbox_aliases;
CREATE POLICY "Members read their invoice aliases"
  ON public.invoice_mailbox_aliases FOR SELECT
  USING (public.is_household_member(household_id));
-- No write policies: aliases change only through set_invoice_alias()

-- Names nobody can take (mailbox roles, environments, the brand)
CREATE OR REPLACE FUNCTION public.invoice_alias_reserved(p_key TEXT)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT p_key = ANY (ARRAY[
    'soporte', 'support', 'ayuda', 'help', 'admin', 'administrador', 'administracion', 'root',
    'facturas', 'factura', 'facturacion', 'billing', 'staging', 'prod', 'produccion', 'test', 'prueba',
    'pruebas', 'avisos', 'noresponder', 'noreply', 'postmaster', 'abuse', 'hostmaster', 'webmaster',
    'mailerdaemon', 'info', 'hola', 'contacto', 'canastica', 'seguridad', 'security', 'privacidad',
    'privacy', 'legal', 'ventas', 'sales'
  ]);
$$;

-- Accent-free, lowercase, letters / digits / single hyphens; NULL when it can't be valid
CREATE OR REPLACE FUNCTION public.normalize_invoice_alias(p_alias TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN v ~ '^[a-z0-9](?:[a-z0-9-]{1,28})[a-z0-9]$' THEN v END
  FROM (
    SELECT btrim(
      regexp_replace(
        regexp_replace(
          translate(lower(btrim(coalesce(p_alias, ''))), 'áàäâãéèëêíìïîóòöôõúùüûñç _.', 'aaaaaeeeeiiiiooooouuuunc---'),
          '[^a-z0-9-]', '', 'g'),
        '-{2,}', '-', 'g'),
      '-') AS v
  ) s;
$$;

-- 'ok' | 'invalid' | 'reserved' | 'taken' | 'mine' (the household already uses it)
CREATE OR REPLACE FUNCTION public.check_invoice_alias(p_alias TEXT, p_household_id UUID DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_alias TEXT := public.normalize_invoice_alias(p_alias);
  v_key TEXT;
  v_owner UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF v_alias IS NULL THEN
    RETURN 'invalid';
  END IF;
  v_key := replace(v_alias, '-', '');
  IF length(v_key) < 3 THEN
    RETURN 'invalid';
  END IF;
  IF public.invoice_alias_reserved(v_key) THEN
    RETURN 'reserved';
  END IF;
  SELECT household_id INTO v_owner
  FROM public.invoice_mailbox_aliases
  WHERE alias_key = v_key AND (expires_at IS NULL OR expires_at > NOW());
  IF v_owner IS NULL THEN
    RETURN 'ok';
  END IF;
  IF p_household_id IS NOT NULL AND v_owner = p_household_id AND public.is_household_member(p_household_id) THEN
    RETURN 'mine';
  END IF;
  RETURN 'taken';
END;
$$;

-- Sets the household's alias; the previous one keeps working for 30 days. Returns the stored alias.
CREATE OR REPLACE FUNCTION public.set_invoice_alias(p_household_id UUID, p_alias TEXT)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_alias TEXT := public.normalize_invoice_alias(p_alias);
  v_key TEXT;
  v_status TEXT;
BEGIN
  IF auth.uid() IS NULL OR NOT public.is_household_member(p_household_id) THEN
    RAISE EXCEPTION 'not_a_member';
  END IF;
  v_status := public.check_invoice_alias(p_alias, p_household_id);
  IF v_status = 'mine' THEN
    v_key := replace(v_alias, '-', '');
    -- Taking back a name used before (still in its 30 days): make it current again
    UPDATE public.invoice_mailbox_aliases SET expires_at = NOW() + INTERVAL '30 days'
    WHERE household_id = p_household_id AND expires_at IS NULL AND alias_key <> v_key;
    UPDATE public.invoice_mailbox_aliases SET expires_at = NULL, alias = v_alias
    WHERE alias_key = v_key;
    RETURN v_alias;
  END IF;
  IF v_status <> 'ok' THEN
    RAISE EXCEPTION 'alias_%', v_status;
  END IF;
  v_key := replace(v_alias, '-', '');

  -- Expired names are free again
  DELETE FROM public.invoice_mailbox_aliases WHERE expires_at IS NOT NULL AND expires_at <= NOW();
  UPDATE public.invoice_mailbox_aliases SET expires_at = NOW() + INTERVAL '30 days'
  WHERE household_id = p_household_id AND expires_at IS NULL;
  INSERT INTO public.invoice_mailbox_aliases (alias_key, alias, household_id, created_by)
  VALUES (v_key, v_alias, p_household_id, auth.uid());
  RETURN v_alias;
END;
$$;

REVOKE ALL ON FUNCTION public.check_invoice_alias(TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.set_invoice_alias(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.check_invoice_alias(TEXT, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.set_invoice_alias(UUID, TEXT) TO authenticated;

-- ---------------------------------------------------------------------------
-- 2. Files and completeness of each received invoice
-- ---------------------------------------------------------------------------
ALTER TABLE public.inbound_invoices
  ADD COLUMN IF NOT EXISTS response_path TEXT,      -- Hacienda's MensajeHacienda XML
  ADD COLUMN IF NOT EXISTS hacienda_status TEXT     -- 'aceptado' | 'rechazado' | other text Hacienda sent
    CHECK (hacienda_status IS NULL OR length(hacienda_status) <= 40),
  ADD COLUMN IF NOT EXISTS is_complete BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS missing TEXT[] NOT NULL DEFAULT '{}';  -- subset of {factura, respuesta, pdf}

-- Find the PDF of an imported purchase
CREATE INDEX IF NOT EXISTS inbound_invoices_purchase_idx
  ON public.inbound_invoices (purchase_id) WHERE purchase_id IS NOT NULL;

-- Only complete sets are imported on their own now, so turn it on by default
ALTER TABLE public.invoice_mailboxes ALTER COLUMN auto_import SET DEFAULT TRUE;
UPDATE public.invoice_mailboxes SET auto_import = TRUE WHERE auto_import = FALSE;
