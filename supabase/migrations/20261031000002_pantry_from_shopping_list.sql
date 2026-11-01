-- Productos de despensa creados al tachar un producto de la lista de compras.
-- Si luego llega una factura con ese producto, la fila se reemplaza en vez de duplicarse.
ALTER TABLE public.pantry_items
  ADD COLUMN IF NOT EXISTS from_shopping_list BOOLEAN NOT NULL DEFAULT FALSE;
