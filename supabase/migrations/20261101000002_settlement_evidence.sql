-- ============================================================================
-- Settlements ("Liquidar"): optional proof of payment and e-mail to the payee
-- ============================================================================

ALTER TABLE public.expense_settlements
  ADD COLUMN IF NOT EXISTS evidence_path TEXT,
  ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES public.profiles(id) ON DELETE SET NULL,
  -- Set by the "assistant" function once the payee was e-mailed, so it is sent only once
  ADD COLUMN IF NOT EXISTS notified_at TIMESTAMPTZ;

-- Private bucket: files live under <household_id>/<settlement_id>.<ext>
INSERT INTO storage.buckets (id, name, public)
VALUES ('settlement-evidence', 'settlement-evidence', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "Household members can view settlement evidence" ON storage.objects;
CREATE POLICY "Household members can view settlement evidence"
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'settlement-evidence'
    AND public.is_household_member((storage.foldername(name))[1]::uuid)
  );

DROP POLICY IF EXISTS "Household members can upload settlement evidence" ON storage.objects;
CREATE POLICY "Household members can upload settlement evidence"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'settlement-evidence'
    AND public.is_household_member((storage.foldername(name))[1]::uuid)
  );
