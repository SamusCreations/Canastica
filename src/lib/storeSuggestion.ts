// ============================================================================
// Most common place of purchase per product, learned from saved receipts.
// ============================================================================
import type { Purchase } from '../types/grocery';

/** A product needs this many purchases before a store is suggested for it. */
export const MIN_PURCHASES_FOR_STORE = 2;

const key = (name: string) => name.trim().toLowerCase();

/** canonical name (lower case) → supermarket where it was bought most often */
export function buildStoreSuggestions(purchases: Purchase[]): Map<string, string> {
  const counts = new Map<string, Map<string, number>>();
  for (const purchase of purchases) {
    const store = purchase.supermarket?.trim();
    if (!store) continue;
    // Count each product once per receipt
    const seen = new Set(purchase.items.map((it) => key(it.canonicalName || it.normalizedName)));
    for (const product of seen) {
      if (!product) continue;
      const byStore = counts.get(product) ?? new Map<string, number>();
      byStore.set(store, (byStore.get(store) ?? 0) + 1);
      counts.set(product, byStore);
    }
  }

  const suggestions = new Map<string, string>();
  for (const [product, byStore] of counts) {
    let total = 0;
    let best: [string, number] | null = null;
    for (const entry of byStore) {
      total += entry[1];
      if (!best || entry[1] > best[1]) best = entry;
    }
    if (best && total >= MIN_PURCHASES_FOR_STORE) suggestions.set(product, best[0]);
  }
  return suggestions;
}

export function suggestedStoreFor(
  suggestions: Map<string, string>,
  item: { name: string; canonicalName: string }
): string | undefined {
  return suggestions.get(key(item.canonicalName || item.name)) ?? suggestions.get(key(item.name));
}
