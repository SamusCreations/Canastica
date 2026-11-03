// ============================================================================
// Last known prices from the household's receipts, used to estimate what a
// shopping list item will cost (Modo súper) without any AI.
// ============================================================================

import type { Purchase, PurchaseItem, ShoppingListItem } from '../types/grocery';

const keyOf = (s: string) => s.trim().toLowerCase();

export interface LastPrice {
  item: PurchaseItem;
  supermarket: string;
  purchaseDate: string;
}

/** Latest receipt line per canonical name (and per normalized name as a fallback key). */
export function buildLastPriceIndex(purchases: Purchase[]): Map<string, LastPrice> {
  const index = new Map<string, LastPrice>();
  const sorted = [...purchases].sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));
  for (const p of sorted) {
    for (const item of p.items) {
      if (!(item.unitPrice > 0) && !(item.totalPrice > 0)) continue;
      const entry = { item, supermarket: p.supermarket, purchaseDate: p.purchaseDate };
      index.set(keyOf(item.canonicalName), entry);
      index.set(keyOf(item.normalizedName), entry);
    }
  }
  return index;
}

export function findLastPrice(index: Map<string, LastPrice>, listItem: Pick<ShoppingListItem, 'name' | 'canonicalName'>): LastPrice | null {
  return index.get(keyOf(listItem.canonicalName || '')) ?? index.get(keyOf(listItem.name)) ?? null;
}

/**
 * Rough cost of a list item: the last unit price times the quantity when the list is in
 * plain units (or the same unit as the receipt); otherwise one receipt line's worth.
 */
export function estimateListItemCost(index: Map<string, LastPrice>, listItem: ShoppingListItem): number | null {
  const last = findLastPrice(index, listItem);
  if (!last) return null;
  const { item } = last;
  const unitPrice = item.unitPrice > 0 ? item.unitPrice : item.totalPrice / Math.max(1, item.quantity);
  const listUnit = keyOf(listItem.unit || '');
  const sameUnit = !listUnit || listUnit === 'unid' || listUnit === keyOf(item.unit || '');
  const qty = listItem.quantity > 0 ? listItem.quantity : 1;
  return Math.round(sameUnit ? unitPrice * qty : unitPrice);
}
