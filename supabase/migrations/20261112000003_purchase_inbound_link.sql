-- The link between an imported purchase and its email invoice used to live only in
-- inbound_invoices.purchase_id, written by a separate request that raced with the
-- purchase insert. When it ran first the foreign key rejected it (and the auto-import
-- path swallowed the error), so the purchase detail could not find the invoice files.
-- Now the purchase itself carries the link, set in the same insert.
ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS inbound_invoice_id UUID REFERENCES public.inbound_invoices(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS purchases_inbound_invoice_idx
  ON public.purchases (inbound_invoice_id) WHERE inbound_invoice_id IS NOT NULL;

-- Backfill 1: links that did get written
UPDATE public.purchases p
SET inbound_invoice_id = i.id
FROM public.inbound_invoices i
WHERE i.purchase_id = p.id AND p.inbound_invoice_id IS NULL;

-- Backfill 2: imported invoices whose link was lost. Link only when exactly one
-- purchase of the household matches the total, date and time window.
WITH matches AS (
  SELECT i.id AS inbound_id, min(p.id::text)::uuid AS purchase_id
  FROM public.inbound_invoices i
  JOIN public.purchases p
    ON p.household_id = i.household_id
   AND p.total_amount = i.total
   AND (i.issued_at IS NULL OR p.purchase_date = i.issued_at)
   AND p.created_at BETWEEN i.received_at - interval '1 hour' AND i.received_at + interval '2 days'
  WHERE i.status = 'imported' AND i.purchase_id IS NULL AND i.total IS NOT NULL
  GROUP BY i.id
  HAVING count(*) = 1
)
UPDATE public.purchases p
SET inbound_invoice_id = m.inbound_id
FROM matches m
WHERE p.id = m.purchase_id AND p.inbound_invoice_id IS NULL;
