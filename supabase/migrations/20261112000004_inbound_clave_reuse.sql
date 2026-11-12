-- An e-invoice (clave) is unique per household only while it is waiting in the tray
-- or imported. Once its purchase is deleted or it is discarded, sending it again must
-- register it again, so rejected/error rows no longer reserve the clave.
DROP INDEX IF EXISTS public.inbound_invoices_clave_unique;
CREATE UNIQUE INDEX IF NOT EXISTS inbound_invoices_clave_unique
  ON public.inbound_invoices (household_id, clave)
  WHERE clave IS NOT NULL AND status IN ('pending', 'imported');
