-- ============================================================================
-- GlassCart: Supabase Auth, Profiles & Household Onboarding
-- Adds automatic profile creation on sign-up, profile RLS, secure RPCs to
-- create / join households by invite code, and the columns the web app needs.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. EXTRA COLUMNS USED BY THE WEB APP
-- ----------------------------------------------------------------------------

ALTER TABLE public.households
  ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'es' CHECK (language IN ('es', 'en')),
  ADD COLUMN IF NOT EXISTS supermarkets JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL;

ALTER TABLE public.households ALTER COLUMN currency SET DEFAULT 'CRC';
ALTER TABLE public.households ALTER COLUMN monthly_budget SET DEFAULT 580000;

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS accent_color TEXT NOT NULL DEFAULT '#2563eb';

-- ----------------------------------------------------------------------------
-- 2. AUTOMATIC PROFILE CREATION ON SIGN-UP
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.profiles (id, full_name, email, avatar_url)
  VALUES (
    NEW.id,
    COALESCE(NULLIF(NEW.raw_user_meta_data->>'full_name', ''), split_part(NEW.email, '@', 1)),
    NEW.email,
    NEW.raw_user_meta_data->>'avatar_url'
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

-- Backfill profiles for users that signed up before this migration
INSERT INTO public.profiles (id, full_name, email, avatar_url)
SELECT
  u.id,
  COALESCE(NULLIF(u.raw_user_meta_data->>'full_name', ''), split_part(u.email, '@', 1)),
  u.email,
  u.raw_user_meta_data->>'avatar_url'
FROM auth.users u
ON CONFLICT (id) DO NOTHING;

-- ----------------------------------------------------------------------------
-- 3. PROFILE RLS (self + people you share a household with)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.shares_household_with(target_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.household_members mine
    JOIN public.household_members theirs ON theirs.household_id = mine.household_id
    WHERE mine.user_id = auth.uid()
      AND theirs.user_id = target_user_id
  );
$$;

DROP POLICY IF EXISTS "Users can view own and co-member profiles" ON public.profiles;
CREATE POLICY "Users can view own and co-member profiles"
  ON public.profiles FOR SELECT
  USING (id = auth.uid() OR public.shares_household_with(id));

DROP POLICY IF EXISTS "Users can insert own profile" ON public.profiles;
CREATE POLICY "Users can insert own profile"
  ON public.profiles FOR INSERT
  WITH CHECK (id = auth.uid());

DROP POLICY IF EXISTS "Users can update own profile" ON public.profiles;
CREATE POLICY "Users can update own profile"
  ON public.profiles FOR UPDATE
  USING (id = auth.uid());

-- Members can leave a household on their own
DROP POLICY IF EXISTS "Members can leave a household" ON public.household_members;
CREATE POLICY "Members can leave a household"
  ON public.household_members FOR DELETE
  USING (user_id = auth.uid());

-- ----------------------------------------------------------------------------
-- 4. ONBOARDING RPCs (SECURITY DEFINER so the creator becomes admin)
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.generate_invite_code()
RETURNS TEXT
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  candidate TEXT;
BEGIN
  LOOP
    candidate := 'GLS-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 5));
    EXIT WHEN NOT EXISTS (SELECT 1 FROM public.households WHERE invite_code = candidate);
  END LOOP;
  RETURN candidate;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_household(
  p_name TEXT,
  p_currency TEXT DEFAULT 'CRC',
  p_language TEXT DEFAULT 'es',
  p_monthly_budget NUMERIC DEFAULT 580000,
  p_supermarkets JSONB DEFAULT '[]'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;
  IF COALESCE(trim(p_name), '') = '' THEN
    RAISE EXCEPTION 'household_name_required';
  END IF;

  INSERT INTO public.households (name, invite_code, monthly_budget, currency, language, supermarkets, created_by)
  VALUES (
    trim(p_name),
    public.generate_invite_code(),
    COALESCE(p_monthly_budget, 580000),
    COALESCE(p_currency, 'CRC'),
    COALESCE(p_language, 'es'),
    COALESCE(p_supermarkets, '[]'::jsonb),
    auth.uid()
  )
  RETURNING id INTO new_id;

  INSERT INTO public.household_members (household_id, user_id, role)
  VALUES (new_id, auth.uid(), 'admin');

  INSERT INTO public.categories (household_id, name, icon, color, monthly_allocation, aisle_order) VALUES
    (new_id, 'Dairy & Eggs',    'Milk',      '#0284c7',  95000, 1),
    (new_id, 'Meat & Poultry',  'Beef',      '#e11d48', 135000, 2),
    (new_id, 'Produce',         'Apple',     '#059669',  98000, 3),
    (new_id, 'Bakery',          'Croissant', '#d97706',  45000, 4),
    (new_id, 'Pantry Staples',  'Package',   '#4f46e5',  78000, 5),
    (new_id, 'Beverages',       'Coffee',    '#7c3aed',  42000, 6),
    (new_id, 'Snacks',          'Cookie',    '#db2777',  32000, 7),
    (new_id, 'Cleaning & Home', 'Sparkles',  '#0d9488',  45000, 8),
    (new_id, 'Personal Care',   'Heart',     '#0891b2',  30000, 9);

  RETURN new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.join_household(p_invite_code TEXT)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  target_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_authenticated';
  END IF;

  SELECT id INTO target_id
  FROM public.households
  WHERE upper(invite_code) = upper(trim(p_invite_code));

  IF target_id IS NULL THEN
    RAISE EXCEPTION 'invalid_invite_code';
  END IF;

  INSERT INTO public.household_members (household_id, user_id, role)
  VALUES (target_id, auth.uid(), 'member')
  ON CONFLICT (household_id, user_id) DO NOTHING;

  RETURN target_id;
END;
$$;

-- Any member (not only admins) can register a new supermarket
CREATE OR REPLACE FUNCTION public.update_household_supermarkets(
  p_household_id UUID,
  p_supermarkets JSONB
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public.is_household_member(p_household_id) THEN
    RAISE EXCEPTION 'not_a_member';
  END IF;
  UPDATE public.households
  SET supermarkets = COALESCE(p_supermarkets, '[]'::jsonb),
      updated_at = NOW()
  WHERE id = p_household_id;
END;
$$;

-- Admins can rotate the invite code if it leaked
CREATE OR REPLACE FUNCTION public.regenerate_invite_code(p_household_id UUID)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  new_code TEXT;
BEGIN
  IF NOT public.is_household_admin(p_household_id) THEN
    RAISE EXCEPTION 'not_an_admin';
  END IF;
  new_code := public.generate_invite_code();
  UPDATE public.households SET invite_code = new_code, updated_at = NOW() WHERE id = p_household_id;
  RETURN new_code;
END;
$$;

REVOKE ALL ON FUNCTION public.create_household(TEXT, TEXT, TEXT, NUMERIC, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.join_household(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.update_household_supermarkets(UUID, JSONB) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.regenerate_invite_code(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_household(TEXT, TEXT, TEXT, NUMERIC, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_household(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_household_supermarkets(UUID, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.regenerate_invite_code(UUID) TO authenticated;

-- ----------------------------------------------------------------------------
-- 5. REALTIME FOR THE REST OF THE SHARED TABLES
-- ----------------------------------------------------------------------------

ALTER PUBLICATION supabase_realtime ADD TABLE public.households;
ALTER PUBLICATION supabase_realtime ADD TABLE public.household_members;
ALTER PUBLICATION supabase_realtime ADD TABLE public.categories;
ALTER PUBLICATION supabase_realtime ADD TABLE public.expense_settlements;
ALTER PUBLICATION supabase_realtime ADD TABLE public.canonical_products;

-- ----------------------------------------------------------------------------
-- 6. RECEIPT IMAGES: allow members to replace / delete their household files
-- ----------------------------------------------------------------------------

DROP POLICY IF EXISTS "Household members can update receipt images" ON storage.objects;
CREATE POLICY "Household members can update receipt images"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'receipts'
    AND public.is_household_member((storage.foldername(name))[1]::uuid)
  );

DROP POLICY IF EXISTS "Household members can delete receipt images" ON storage.objects;
CREATE POLICY "Household members can delete receipt images"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'receipts'
    AND public.is_household_member((storage.foldername(name))[1]::uuid)
  );
