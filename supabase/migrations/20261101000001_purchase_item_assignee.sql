-- Persona a la que se le asigna un producto personal (si es NULL, es de quien pagó la factura).
ALTER TABLE public.purchase_items
  ADD COLUMN IF NOT EXISTS assigned_to UUID REFERENCES public.profiles(id) ON DELETE SET NULL;
