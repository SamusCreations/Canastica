-- ============================================================================
-- Household activity log: who did (or undid) what.
-- Written only by triggers (SECURITY DEFINER); members can read their household's log.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.household_activity (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  household_id UUID NOT NULL REFERENCES public.households(id) ON DELETE CASCADE,
  actor_id UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  entity TEXT NOT NULL,      -- purchase | shopping_item | pantry_item | settlement | member | household | purchase_item
  action TEXT NOT NULL,      -- created | updated | deleted | checked | unchecked | …
  summary TEXT NOT NULL,     -- Spanish sentence without the actor, e.g. 'tachó "Leche" de la lista'
  entity_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS household_activity_household_created_idx
  ON public.household_activity (household_id, created_at DESC);

ALTER TABLE public.household_activity ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Members can read their household activity" ON public.household_activity;
CREATE POLICY "Members can read their household activity"
  ON public.household_activity FOR SELECT
  USING (public.is_household_member(household_id));

REVOKE INSERT, UPDATE, DELETE ON public.household_activity FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.log_household_activity(
  p_household_id UUID, p_entity TEXT, p_action TEXT, p_summary TEXT, p_entity_id UUID
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF p_household_id IS NULL OR p_summary IS NULL THEN
    RETURN;
  END IF;
  -- The household may be in the middle of being deleted (cascade): skip quietly
  IF NOT EXISTS (SELECT 1 FROM public.households WHERE id = p_household_id) THEN
    RETURN;
  END IF;
  INSERT INTO public.household_activity (household_id, actor_id, entity, action, summary, entity_id)
  VALUES (p_household_id, auth.uid(), p_entity, p_action, left(p_summary, 300), p_entity_id);
END;
$$;

REVOKE ALL ON FUNCTION public.log_household_activity(UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.member_display_name(p_user_id UUID) RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT COALESCE(split_part(full_name, ' ', 1), 'alguien') FROM public.profiles WHERE id = p_user_id $$;

REVOKE ALL ON FUNCTION public.member_display_name(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.colones(p_amount NUMERIC) RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$ SELECT '₡' || to_char(round(p_amount), 'FM999G999G999') $$;

-- ---------------------------------------------------------------------------
-- Triggers per table
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.trg_activity_purchases() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM log_household_activity(NEW.household_id, 'purchase', 'created',
      format('registró una compra en %s por %s', NEW.supermarket, colones(NEW.total_amount)), NEW.id);
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM log_household_activity(NEW.household_id, 'purchase', 'updated',
      format('editó la compra de %s (%s)', NEW.supermarket, colones(NEW.total_amount)), NEW.id);
  ELSE
    PERFORM log_household_activity(OLD.household_id, 'purchase', 'deleted',
      format('eliminó la compra de %s por %s', OLD.supermarket, colones(OLD.total_amount)), OLD.id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_activity_purchase_items() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_owner TEXT;
BEGIN
  -- Only changes in who pays for a line are logged; lines come and go with their receipt
  IF NEW.is_shared IS DISTINCT FROM OLD.is_shared
     OR (to_jsonb(NEW) ->> 'assigned_to') IS DISTINCT FROM (to_jsonb(OLD) ->> 'assigned_to') THEN
    IF NEW.is_shared THEN
      v_owner := 'compartido';
    ELSE
      v_owner := 'personal de ' || COALESCE(member_display_name(
        COALESCE((to_jsonb(NEW) ->> 'assigned_to')::uuid, NEW.created_by)), 'alguien');
    END IF;
    PERFORM log_household_activity(NEW.household_id, 'purchase_item', 'assigned',
      format('marcó "%s" como %s', NEW.normalized_name, v_owner), NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_activity_shopping_items() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM log_household_activity(NEW.household_id, 'shopping_item', 'created',
      format('agregó "%s" a la lista', NEW.name), NEW.id);
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW.is_checked IS DISTINCT FROM OLD.is_checked THEN
      IF NEW.is_checked AND NEW.matched_purchase_id IS NOT NULL THEN
        PERFORM log_household_activity(NEW.household_id, 'shopping_item', 'checked',
          format('tachó "%s" con una factura', NEW.name), NEW.id);
      ELSIF NEW.is_checked THEN
        PERFORM log_household_activity(NEW.household_id, 'shopping_item', 'checked',
          format('tachó "%s" de la lista', NEW.name), NEW.id);
      ELSE
        PERFORM log_household_activity(NEW.household_id, 'shopping_item', 'unchecked',
          format('destachó "%s"', NEW.name), NEW.id);
      END IF;
    ELSIF (to_jsonb(NEW) ->> 'store') IS DISTINCT FROM (to_jsonb(OLD) ->> 'store') THEN
      PERFORM log_household_activity(NEW.household_id, 'shopping_item', 'updated',
        format('cambió el lugar de "%s" a %s', NEW.name, COALESCE(to_jsonb(NEW) ->> 'store', 'ninguno')), NEW.id);
    END IF;
  ELSE
    PERFORM log_household_activity(OLD.household_id, 'shopping_item', 'deleted',
      format('quitó "%s" de la lista', OLD.name), OLD.id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_activity_pantry_items() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  -- Receipt saves add many rows at once; only manual status changes and removals are logged
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM log_household_activity(NEW.household_id, 'pantry_item', 'updated',
      format('marcó "%s" como %s', NEW.name,
        CASE NEW.status WHEN 'ran_out' THEN 'agotado' WHEN 'running_low' THEN 'por acabarse' ELSE 'disponible' END),
      NEW.id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM log_household_activity(OLD.household_id, 'pantry_item', 'deleted',
      format('quitó "%s" de la despensa', OLD.name), OLD.id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_activity_settlements() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM log_household_activity(NEW.household_id, 'settlement', 'created',
      format('registró que %s le pagó %s a %s', member_display_name(NEW.from_member_id),
        colones(NEW.amount), member_display_name(NEW.to_member_id)), NEW.id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM log_household_activity(OLD.household_id, 'settlement', 'deleted',
      format('anuló la liquidación de %s a %s por %s', member_display_name(OLD.from_member_id),
        member_display_name(OLD.to_member_id), colones(OLD.amount)), OLD.id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_activity_members() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM log_household_activity(NEW.household_id, 'member', 'created',
      format('agregó a %s al hogar', member_display_name(NEW.user_id)), NEW.user_id);
  ELSIF TG_OP = 'UPDATE' AND NEW.role IS DISTINCT FROM OLD.role THEN
    PERFORM log_household_activity(NEW.household_id, 'member', 'updated',
      format('cambió el rol de %s a %s', member_display_name(NEW.user_id),
        CASE NEW.role WHEN 'admin' THEN 'administrador' ELSE 'miembro' END), NEW.user_id);
  ELSIF TG_OP = 'DELETE' THEN
    PERFORM log_household_activity(OLD.household_id, 'member', 'deleted',
      format('sacó a %s del hogar', member_display_name(OLD.user_id)), OLD.user_id);
  END IF;
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.trg_activity_households() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.monthly_budget IS DISTINCT FROM OLD.monthly_budget THEN
    PERFORM log_household_activity(NEW.id, 'household', 'updated',
      format('cambió el presupuesto mensual de %s a %s', colones(OLD.monthly_budget), colones(NEW.monthly_budget)), NEW.id);
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    PERFORM log_household_activity(NEW.id, 'household', 'updated',
      format('renombró el hogar a "%s"', NEW.name), NEW.id);
  END IF;
  IF NEW.restock_lookback_months IS DISTINCT FROM OLD.restock_lookback_months
     OR NEW.restock_alert_days IS DISTINCT FROM OLD.restock_alert_days
     OR NEW.min_purchases_for_prediction IS DISTINCT FROM OLD.min_purchases_for_prediction THEN
    PERFORM log_household_activity(NEW.id, 'household', 'updated', 'cambió los ajustes de reposición', NEW.id);
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS activity_purchases ON public.purchases;
CREATE TRIGGER activity_purchases AFTER INSERT OR UPDATE OR DELETE ON public.purchases
  FOR EACH ROW EXECUTE FUNCTION public.trg_activity_purchases();

DROP TRIGGER IF EXISTS activity_purchase_items ON public.purchase_items;
CREATE TRIGGER activity_purchase_items AFTER UPDATE ON public.purchase_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_activity_purchase_items();

DROP TRIGGER IF EXISTS activity_shopping_items ON public.shopping_list_items;
CREATE TRIGGER activity_shopping_items AFTER INSERT OR UPDATE OR DELETE ON public.shopping_list_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_activity_shopping_items();

DROP TRIGGER IF EXISTS activity_pantry_items ON public.pantry_items;
CREATE TRIGGER activity_pantry_items AFTER UPDATE OR DELETE ON public.pantry_items
  FOR EACH ROW EXECUTE FUNCTION public.trg_activity_pantry_items();

DROP TRIGGER IF EXISTS activity_settlements ON public.expense_settlements;
CREATE TRIGGER activity_settlements AFTER INSERT OR DELETE ON public.expense_settlements
  FOR EACH ROW EXECUTE FUNCTION public.trg_activity_settlements();

DROP TRIGGER IF EXISTS activity_members ON public.household_members;
CREATE TRIGGER activity_members AFTER INSERT OR UPDATE OR DELETE ON public.household_members
  FOR EACH ROW EXECUTE FUNCTION public.trg_activity_members();

DROP TRIGGER IF EXISTS activity_households ON public.households;
CREATE TRIGGER activity_households AFTER UPDATE ON public.households
  FOR EACH ROW EXECUTE FUNCTION public.trg_activity_households();
