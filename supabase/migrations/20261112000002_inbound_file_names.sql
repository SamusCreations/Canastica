-- Original attachment names of each email invoice, so the three files
-- (invoice XML, Hacienda response, PDF) can be downloaded as they arrived.
ALTER TABLE public.inbound_invoices
  ADD COLUMN IF NOT EXISTS file_names JSONB NOT NULL DEFAULT '{}'::jsonb;  -- {factura, respuesta, pdf}
