-- ============================================================================
-- Shared shopping list links (canastica.app/l/<token>).
-- People outside the household never touch the tables directly: everything goes
-- through SECURITY DEFINER functions that check the token, its permissions,
-- expiry and a per-link rate limit on the server.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.shared_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE CHECK (char_length(token) >= 20),
  created_by UUID NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  can_check BOOLEAN NOT NULL DEFAULT FALSE,
  can_add BOOLEAN NOT NULL DEFAULT FALSE,
  can_delete BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  rate_window_start TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  rate_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS shared_lists_household_idx ON public.shared_lists (household_id);

ALTER TABLE public.shared_lists ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members read their household share links" ON public.shared_lists;
CREATE POLICY "Members read their household share links"
  ON public.shared_lists FOR SELECT
  USING (public.is_household_member(household_id));

DROP POLICY IF EXISTS "Members create share links" ON public.shared_lists;
CREATE POLICY "Members create share links"
  ON public.shared_lists FOR INSERT
  WITH CHECK (public.is_household_member(household_id) AND created_by = auth.uid());

DROP POLICY IF EXISTS "Members update share links" ON public.shared_lists;
CREATE POLICY "Members update share links"
  ON public.shared_lists FOR UPDATE
  USING (public.is_household_member(household_id))
  WITH CHECK (public.is_household_member(household_id));

DROP POLICY IF EXISTS "Members delete share links" ON public.shared_lists;
CREATE POLICY "Members delete share links"
  ON public.shared_lists FOR DELETE
  USING (public.is_household_member(household_id));

-- ---------------------------------------------------------------------------
-- Activity log: changes made through a link carry the name the visitor typed
-- ---------------------------------------------------------------------------

ALTER TABLE public.household_activity ADD COLUMN IF NOT EXISTS actor_label TEXT;

CREATE OR REPLACE FUNCTION public.log_household_activity(
  p_household_id UUID, p_entity TEXT, p_action TEXT, p_summary TEXT, p_entity_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_label TEXT := NULLIF(current_setting('canastica.external_actor', true), '');
BEGIN
  IF p_household_id IS NULL OR p_summary IS NULL THEN
    RETURN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.households WHERE id = p_household_id) THEN
    RETURN;
  END IF;
  INSERT INTO public.household_activity (household_id, actor_id, actor_label, entity, action, summary, entity_id)
  VALUES (p_household_id, auth.uid(), CASE WHEN v_label IS NOT NULL THEN left(v_label, 40) || ' (enlace)' END,
          p_entity, p_action, left(p_summary, 300), p_entity_id);
END;
$$;

REVOKE ALL ON FUNCTION public.log_household_activity(UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Link checks
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.shared_list_resolve(p_token TEXT)
RETURNS public.shared_lists
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_link public.shared_lists;
BEGIN
  SELECT * INTO v_link FROM public.shared_lists WHERE token = p_token;
  IF v_link.id IS NULL OR NOT v_link.is_active OR (v_link.expires_at IS NOT NULL AND v_link.expires_at < NOW()) THEN
    RAISE EXCEPTION 'invalid_link' USING ERRCODE = 'P0001';
  END IF;
  RETURN v_link;
END;
$$;

REVOKE ALL ON FUNCTION public.shared_list_resolve(TEXT) FROM PUBLIC, anon, authenticated;

/** Validates permission + rate limit (30 changes per minute per link) and tags the activity log. */
CREATE OR REPLACE FUNCTION public.shared_list_begin_write(p_token TEXT, p_permission TEXT, p_actor TEXT)
RETURNS public.shared_lists
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_link public.shared_lists;
  v_actor TEXT := btrim(regexp_replace(COALESCE(p_actor, ''), '[[:cntrl:]]', '', 'g'));
BEGIN
  v_link := shared_list_resolve(p_token);
  IF (p_permission = 'check' AND NOT v_link.can_check)
     OR (p_permission = 'add' AND NOT v_link.can_add)
     OR (p_permission = 'delete' AND NOT v_link.can_delete) THEN
    RAISE EXCEPTION 'not_allowed' USING ERRCODE = 'P0001';
  END IF;
  IF char_length(v_actor) < 1 THEN
    RAISE EXCEPTION 'name_required' USING ERRCODE = 'P0001';
  END IF;

  IF v_link.rate_window_start < NOW() - INTERVAL '1 minute' THEN
    UPDATE public.shared_lists SET rate_window_start = NOW(), rate_count = 1 WHERE id = v_link.id;
  ELSIF v_link.rate_count >= 30 THEN
    RAISE EXCEPTION 'rate_limited' USING ERRCODE = 'P0001';
  ELSE
    UPDATE public.shared_lists SET rate_count = rate_count + 1 WHERE id = v_link.id;
  END IF;

  PERFORM set_config('canastica.external_actor', left(v_actor, 40), true);
  RETURN v_link;
END;
$$;

REVOKE ALL ON FUNCTION public.shared_list_begin_write(TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Public API (anon + authenticated)
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.shared_list_view(p_token TEXT)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_link public.shared_lists;
BEGIN
  v_link := shared_list_resolve(p_token);
  RETURN jsonb_build_object(
    'householdName', (SELECT name FROM public.households WHERE id = v_link.household_id),
    'canCheck', v_link.can_check,
    'canAdd', v_link.can_add,
    'canDelete', v_link.can_delete,
    'expiresAt', v_link.expires_at,
    'items', COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'id', s.id, 'name', s.name, 'quantity', s.quantity, 'unit', s.unit, 'category', s.category,
        'isChecked', s.is_checked, 'store', to_jsonb(s) ->> 'store'
      ) ORDER BY s.is_checked, s.created_at DESC)
      FROM public.shopping_list_items s
      WHERE s.household_id = v_link.household_id
        AND (NOT s.is_checked OR s.checked_at > NOW() - INTERVAL '2 days')
    ), '[]'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.shared_list_toggle(p_token TEXT, p_item_id UUID, p_checked BOOLEAN, p_actor TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_link public.shared_lists;
BEGIN
  v_link := shared_list_begin_write(p_token, 'check', p_actor);
  UPDATE public.shopping_list_items
     SET is_checked = p_checked,
         checked_by = NULL,
         checked_at = CASE WHEN p_checked THEN NOW() ELSE NULL END
   WHERE id = p_item_id AND household_id = v_link.household_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.shared_list_add(
  p_token TEXT, p_name TEXT, p_quantity NUMERIC, p_unit TEXT, p_actor TEXT
) RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_link public.shared_lists;
  v_name TEXT := btrim(left(COALESCE(p_name, ''), 80));
  v_id UUID;
BEGIN
  v_link := shared_list_begin_write(p_token, 'add', p_actor);
  IF char_length(v_name) < 1 THEN
    RAISE EXCEPTION 'name_required' USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.shopping_list_items (household_id, name, canonical_name, category, quantity, unit, created_by)
  VALUES (
    v_link.household_id, v_name, v_name, 'Pantry Staples',
    LEAST(GREATEST(COALESCE(p_quantity, 1), 0.01), 9999),
    COALESCE(NULLIF(btrim(left(p_unit, 20)), ''), 'unid'),
    v_link.created_by
  )
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.shared_list_delete(p_token TEXT, p_item_id UUID, p_actor TEXT)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_link public.shared_lists;
BEGIN
  v_link := shared_list_begin_write(p_token, 'delete', p_actor);
  DELETE FROM public.shopping_list_items WHERE id = p_item_id AND household_id = v_link.household_id;
END;
$$;

REVOKE ALL ON FUNCTION public.shared_list_view(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shared_list_toggle(TEXT, UUID, BOOLEAN, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shared_list_add(TEXT, TEXT, NUMERIC, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.shared_list_delete(TEXT, UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.shared_list_view(TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shared_list_toggle(TEXT, UUID, BOOLEAN, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shared_list_add(TEXT, TEXT, NUMERIC, TEXT, TEXT) TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.shared_list_delete(TEXT, UUID, TEXT) TO anon, authenticated;
