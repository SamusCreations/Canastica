-- ============================================================================
-- Price rise alerts: computed by the app when a receipt is saved, stored per
-- household so every member sees them (and so the weekly summary can list them).
-- ============================================================================

ALTER TABLE public.households
  ADD COLUMN IF NOT EXISTS price_alert_threshold NUMERIC(5, 2) NOT NULL DEFAULT 10
  CHECK (price_alert_threshold >= 1 AND price_alert_threshold <= 100);

CREATE TABLE IF NOT EXISTS public.price_alerts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  purchase_id UUID REFERENCES public.purchases(id) ON DELETE CASCADE,
  canonical_name TEXT NOT NULL,
  product_name TEXT NOT NULL,
  supermarket TEXT NOT NULL,
  previous_price NUMERIC(12, 2) NOT NULL,   -- average per kg / L / unit before this purchase
  new_price NUMERIC(12, 2) NOT NULL,        -- price per kg / L / unit in this purchase
  unit_label TEXT NOT NULL DEFAULT 'unid',
  change_pct NUMERIC(6, 2) NOT NULL,
  seen BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS price_alerts_household_created_idx ON public.price_alerts (household_id, created_at DESC);

ALTER TABLE public.price_alerts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members manage price alerts" ON public.price_alerts;
CREATE POLICY "Members manage price alerts"
  ON public.price_alerts FOR ALL
  USING (public.is_household_member(household_id))
  WITH CHECK (public.is_household_member(household_id));

CREATE TABLE IF NOT EXISTS public.price_alert_mutes (
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  canonical_name TEXT NOT NULL,
  muted_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (household_id, canonical_name)
);

ALTER TABLE public.price_alert_mutes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members manage price alert mutes" ON public.price_alert_mutes;
CREATE POLICY "Members manage price alert mutes"
  ON public.price_alert_mutes FOR ALL
  USING (public.is_household_member(household_id))
  WITH CHECK (public.is_household_member(household_id));
