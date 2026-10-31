-- Lugar de compra (supermercado) de cada producto de la lista de compras.
ALTER TABLE public.shopping_list_items
  ADD COLUMN IF NOT EXISTS store TEXT;
