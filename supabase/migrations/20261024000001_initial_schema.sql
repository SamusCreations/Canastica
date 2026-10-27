-- ============================================================================
-- GlassCart: Liquid Glass Household Grocery & Receipt Intelligence
-- Supabase PostgreSQL Schema, RLS Policies, Realtime, Storage & pg_cron
-- ============================================================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_cron";

-- ----------------------------------------------------------------------------
-- 1. CORE TABLES: Households, Profiles, Members, Categories
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.households (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  invite_code TEXT NOT NULL UNIQUE,
  monthly_budget NUMERIC(12, 2) NOT NULL DEFAULT 1200.00,
  currency TEXT NOT NULL DEFAULT 'USD',
  restock_lookback_months INTEGER NOT NULL DEFAULT 6 CHECK (restock_lookback_months IN (3, 6, 12)),
  restock_alert_days INTEGER NOT NULL DEFAULT 2 CHECK (restock_alert_days BETWEEN 1 AND 14),
  min_purchases_for_prediction INTEGER NOT NULL DEFAULT 3 CHECK (min_purchases_for_prediction >= 2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.profiles (
  id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  avatar_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.household_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (household_id, user_id)
);

CREATE TABLE IF NOT EXISTS public.categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT NOT NULL DEFAULT 'ShoppingBag',
  color TEXT NOT NULL DEFAULT '#38bdf8',
  monthly_allocation NUMERIC(12, 2) NOT NULL DEFAULT 150.00,
  aisle_order INTEGER NOT NULL DEFAULT 1,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (household_id, name)
);

-- ----------------------------------------------------------------------------
-- 2. CANONICAL PRODUCTS & PURCHASES / RECEIPTS
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.canonical_products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  base_unit TEXT NOT NULL CHECK (base_unit IN ('ml', 'g', 'units')),
  aliases TEXT[] NOT NULL DEFAULT '{}',
  feedback_multiplier NUMERIC(6, 3) NOT NULL DEFAULT 1.000,
  default_shelf_life_days INTEGER NOT NULL DEFAULT 10,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (household_id, name)
);

CREATE TABLE IF NOT EXISTS public.purchases (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  supermarket TEXT NOT NULL,
  purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
  subtotal NUMERIC(12, 2) NOT NULL DEFAULT 0,
  discounts NUMERIC(12, 2) NOT NULL DEFAULT 0,
  taxes NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_amount NUMERIC(12, 2) NOT NULL DEFAULT 0,
  receipt_image_path TEXT,
  notes TEXT,
  is_verified BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.purchase_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id UUID NOT NULL REFERENCES public.purchases(id) ON DELETE CASCADE,
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  canonical_product_id UUID REFERENCES public.canonical_products(id) ON DELETE SET NULL,
  raw_receipt_name TEXT,
  normalized_name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  category TEXT NOT NULL,
  quantity NUMERIC(10, 3) NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'unit',
  base_unit_quantity NUMERIC(12, 3) NOT NULL DEFAULT 1,
  base_unit TEXT NOT NULL CHECK (base_unit IN ('ml', 'g', 'units')),
  unit_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  total_price NUMERIC(12, 2) NOT NULL DEFAULT 0,
  is_shared BOOLEAN NOT NULL DEFAULT TRUE,
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  purchase_date DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 3. SHARED SHOPPING LIST, PANTRY & RESTOCK PREDICTIONS
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.shopping_list_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  canonical_product_id UUID REFERENCES public.canonical_products(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  canonical_name TEXT,
  category TEXT NOT NULL DEFAULT 'Pantry',
  quantity NUMERIC(10, 2) NOT NULL DEFAULT 1,
  unit TEXT NOT NULL DEFAULT 'unit',
  is_checked BOOLEAN NOT NULL DEFAULT FALSE,
  checked_by UUID REFERENCES public.profiles(id),
  checked_at TIMESTAMPTZ,
  matched_purchase_id UUID REFERENCES public.purchases(id) ON DELETE SET NULL,
  matched_receipt_item_name TEXT,
  is_predicted BOOLEAN NOT NULL DEFAULT FALSE,
  predicted_reason TEXT,
  created_by UUID NOT NULL REFERENCES public.profiles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.pantry_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  canonical_product_id UUID REFERENCES public.canonical_products(id) ON DELETE SET NULL,
  purchase_item_id UUID REFERENCES public.purchase_items(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  category TEXT NOT NULL,
  storage_location TEXT NOT NULL DEFAULT 'Fridge' CHECK (storage_location IN ('Fridge', 'Freezer', 'Dry Pantry', 'Household')),
  quantity_label TEXT NOT NULL,
  base_quantity NUMERIC(12, 2) NOT NULL,
  base_unit TEXT NOT NULL CHECK (base_unit IN ('ml', 'g', 'units')),
  remaining_percentage INTEGER NOT NULL DEFAULT 100 CHECK (remaining_percentage BETWEEN 0 AND 100),
  purchased_date DATE NOT NULL DEFAULT CURRENT_DATE,
  estimated_expiry_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'running_low', 'ran_out')),
  added_by UUID NOT NULL REFERENCES public.profiles(id),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.restock_predictions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  canonical_product_id UUID REFERENCES public.canonical_products(id) ON DELETE CASCADE,
  canonical_name TEXT NOT NULL,
  category TEXT NOT NULL,
  base_unit TEXT NOT NULL CHECK (base_unit IN ('ml', 'g', 'units')),
  weighted_daily_rate NUMERIC(12, 4) NOT NULL,
  last_purchase_date DATE NOT NULL,
  last_purchase_base_qty NUMERIC(12, 2) NOT NULL,
  last_purchase_display_qty TEXT NOT NULL,
  expected_duration_days NUMERIC(8, 2) NOT NULL,
  estimated_days_remaining NUMERIC(8, 2) NOT NULL,
  confidence_level TEXT NOT NULL CHECK (confidence_level IN ('high', 'medium', 'low')),
  purchase_count INTEGER NOT NULL,
  grouped_variants TEXT[] NOT NULL DEFAULT '{}',
  ai_explanation TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (household_id, canonical_name)
);

CREATE TABLE IF NOT EXISTS public.expense_settlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  from_member_id UUID NOT NULL REFERENCES public.profiles(id),
  to_member_id UUID NOT NULL REFERENCES public.profiles(id),
  amount NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  note TEXT,
  settled_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.household_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('restock_alert', 'price_spike', 'expiry_warning', 'auto_cross_off', 'budget_alert')),
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  is_read BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ----------------------------------------------------------------------------
-- 4. ROW LEVEL SECURITY (RLS) HELPER FUNCTIONS & POLICIES
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_household_member(target_household_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.household_members hm
    WHERE hm.household_id = target_household_id
      AND hm.user_id = auth.uid()
  );
$$;

CREATE OR REPLACE FUNCTION public.is_household_admin(target_household_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.household_members hm
    WHERE hm.household_id = target_household_id
      AND hm.user_id = auth.uid()
      AND hm.role = 'admin'
  );
$$;

ALTER TABLE public.households ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.household_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.canonical_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.purchase_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.shopping_list_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pantry_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.restock_predictions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_settlements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.household_notifications ENABLE ROW LEVEL SECURITY;

-- Households: members can read; admins can update
CREATE POLICY "Members can view their households"
  ON public.households FOR SELECT
  USING (public.is_household_member(id));

CREATE POLICY "Admins can update their household settings"
  ON public.households FOR UPDATE
  USING (public.is_household_admin(id));

CREATE POLICY "Authenticated users can create households"
  ON public.households FOR INSERT
  WITH CHECK (auth.uid() IS NOT NULL);

-- Household Members: members can read; admins can update/delete
CREATE POLICY "Members can view household membership"
  ON public.household_members FOR SELECT
  USING (public.is_household_member(household_id));

CREATE POLICY "Admins can manage household members"
  ON public.household_members FOR ALL
  USING (public.is_household_admin(household_id));

-- Categories: members can read; admins can manage
CREATE POLICY "Members can view categories"
  ON public.categories FOR SELECT
  USING (public.is_household_member(household_id));

CREATE POLICY "Admins can manage categories"
  ON public.categories FOR ALL
  USING (public.is_household_admin(household_id));

-- Canonical products, purchases, items, shopping list, pantry, predictions, settlements, notifications
CREATE POLICY "Household isolation for canonical_products"
  ON public.canonical_products FOR ALL
  USING (public.is_household_member(household_id))
  WITH CHECK (public.is_household_member(household_id));

CREATE POLICY "Household isolation for purchases"
  ON public.purchases FOR ALL
  USING (public.is_household_member(household_id))
  WITH CHECK (public.is_household_member(household_id));

CREATE POLICY "Household isolation for purchase_items"
  ON public.purchase_items FOR ALL
  USING (public.is_household_member(household_id))
  WITH CHECK (public.is_household_member(household_id));

CREATE POLICY "Household isolation for shopping_list_items"
  ON public.shopping_list_items FOR ALL
  USING (public.is_household_member(household_id))
  WITH CHECK (public.is_household_member(household_id));

CREATE POLICY "Household isolation for pantry_items"
  ON public.pantry_items FOR ALL
  USING (public.is_household_member(household_id))
  WITH CHECK (public.is_household_member(household_id));

CREATE POLICY "Household isolation for restock_predictions"
  ON public.restock_predictions FOR ALL
  USING (public.is_household_member(household_id))
  WITH CHECK (public.is_household_member(household_id));

CREATE POLICY "Household isolation for expense_settlements"
  ON public.expense_settlements FOR ALL
  USING (public.is_household_member(household_id))
  WITH CHECK (public.is_household_member(household_id));

CREATE POLICY "Household isolation for household_notifications"
  ON public.household_notifications FOR ALL
  USING (public.is_household_member(household_id))
  WITH CHECK (public.is_household_member(household_id));

-- ----------------------------------------------------------------------------
-- 5. PRIVATE STORAGE BUCKET FOR RECEIPT IMAGES (PER HOUSEHOLD)
-- ----------------------------------------------------------------------------

INSERT INTO storage.buckets (id, name, public)
VALUES ('receipts', 'receipts', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Household members can view receipt images in their household folder"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'receipts'
    AND public.is_household_member((storage.foldername(name))[1]::uuid)
  );

CREATE POLICY "Household members can upload receipt images to their household folder"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'receipts'
    AND public.is_household_member((storage.foldername(name))[1]::uuid)
  );

-- ----------------------------------------------------------------------------
-- 6. REALTIME SUBSCRIPTIONS
-- ----------------------------------------------------------------------------

ALTER PUBLICATION supabase_realtime ADD TABLE public.purchases;
ALTER PUBLICATION supabase_realtime ADD TABLE public.purchase_items;
ALTER PUBLICATION supabase_realtime ADD TABLE public.shopping_list_items;
ALTER PUBLICATION supabase_realtime ADD TABLE public.pantry_items;
ALTER PUBLICATION supabase_realtime ADD TABLE public.restock_predictions;
ALTER PUBLICATION supabase_realtime ADD TABLE public.household_notifications;

-- ----------------------------------------------------------------------------
-- 7. DAILY RESTOCK PREDICTION ENGINE STORED PROCEDURE & PG_CRON SCHEDULE
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.recalculate_all_households_restock_predictions()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  rec RECORD;
  days_elapsed NUMERIC;
  new_remaining NUMERIC;
BEGIN
  -- Decrement remaining days based on elapsed time since last purchase and auto-add items at threshold
  FOR rec IN
    SELECT rp.*, h.restock_alert_days, h.id AS h_id
    FROM public.restock_predictions rp
    JOIN public.households h ON h.id = rp.household_id
  LOOP
    days_elapsed := GREATEST(0, CURRENT_DATE - rec.last_purchase_date);
    new_remaining := ROUND(GREATEST(0, rec.expected_duration_days - days_elapsed), 1);

    UPDATE public.restock_predictions
    SET estimated_days_remaining = new_remaining,
        updated_at = NOW()
    WHERE id = rec.id;

    -- Auto-add to shopping list with 'Predicted' tag if within alert threshold
    IF new_remaining <= rec.restock_alert_days THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.shopping_list_items sli
        WHERE sli.household_id = rec.h_id
          AND LOWER(sli.canonical_name) = LOWER(rec.canonical_name)
          AND sli.is_checked = FALSE
      ) THEN
        INSERT INTO public.shopping_list_items (
          household_id, name, canonical_name, category, quantity, unit,
          is_checked, is_predicted, predicted_reason,
          created_by
        )
        SELECT
          rec.h_id,
          rec.canonical_name,
          rec.canonical_name,
          rec.category,
          1,
          rec.last_purchase_display_qty,
          FALSE,
          TRUE,
          'Predicted to run out in ' || new_remaining || ' days (' || ROUND(rec.weighted_daily_rate, 0) || ' ' || rec.base_unit || '/day)',
          hm.user_id
        FROM public.household_members hm
        WHERE hm.household_id = rec.h_id
        LIMIT 1;

        INSERT INTO public.household_notifications (
          household_id, type, title, message
        ) VALUES (
          rec.h_id,
          'restock_alert',
          rec.canonical_name || ' is running low',
          rec.ai_explanation
        );
      END IF;
    END IF;
  END LOOP;
END;
$$;

-- Schedule daily recalculation at 03:00 UTC via pg_cron
SELECT cron.schedule(
  'glasscart-daily-restock-recalc',
  '0 3 * * *',
  $$SELECT public.recalculate_all_households_restock_predictions();$$
);
