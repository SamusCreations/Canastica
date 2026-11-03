// ============================================================================
// Price comparison between supermarkets, from the household's own receipts.
// Prices are compared per base unit (per kg, per litre or per unit) so different
// package sizes are fair. Only recent data (90 days) and products seen in at
// least two stores are compared. Computed locally, no AI.
// ============================================================================

import type { BaseUnit, Purchase, PurchaseItem } from '../types/grocery';
import { addDaysIso, getCurrentMonthPrefix, getTodayIso } from '../utils/dates';

export const COMPARISON_WINDOW_DAYS = 90;

export interface StorePriceStats {
  store: string;
  /** Price per kg / L / unit */
  lastPrice: number;
  avgPrice: number;
  lastDate: string;
  count: number;
}

export interface ProductComparison {
  key: string;
  name: string;
  baseUnit: BaseUnit;
  unitLabel: string; // "kg" | "L" | "unid"
  stores: StorePriceStats[]; // cheapest (by average) first
  cheapest: StorePriceStats;
  priciest: StorePriceStats;
  /** How much cheaper the cheapest store is than the priciest, in % */
  spreadPct: number;
}

const keyOf = (s: string) => s.trim().toLowerCase();

export function unitLabelFor(baseUnit: BaseUnit): string {
  return baseUnit === 'g' ? 'kg' : baseUnit === 'ml' ? 'L' : 'unid';
}

/** Price per kg, per litre or per unit for one receipt line; null when it can't be computed. */
export function pricePerStandardUnit(item: PurchaseItem): number | null {
  if (!(item.totalPrice > 0) || !(item.baseUnitQuantity > 0)) return null;
  const perBase = item.totalPrice / item.baseUnitQuantity;
  return item.baseUnit === 'units' ? perBase : perBase * 1000;
}

export function buildPriceComparisons(purchases: Purchase[], today = getTodayIso()): ProductComparison[] {
  const since = addDaysIso(today, -COMPARISON_WINDOW_DAYS);
  // product -> store -> points
  const byProduct = new Map<string, { name: string; baseUnit: BaseUnit; stores: Map<string, { date: string; price: number }[]> }>();

  for (const p of purchases) {
    if (p.purchaseDate < since || !p.supermarket) continue;
    for (const item of p.items) {
      const price = pricePerStandardUnit(item);
      if (price === null) continue;
      const key = `${keyOf(item.canonicalName || item.normalizedName)}|${item.baseUnit}`;
      let entry = byProduct.get(key);
      if (!entry) {
        entry = { name: item.canonicalName || item.normalizedName, baseUnit: item.baseUnit, stores: new Map() };
        byProduct.set(key, entry);
      }
      const store = p.supermarket.trim();
      const list = entry.stores.get(store) ?? [];
      list.push({ date: p.purchaseDate, price });
      entry.stores.set(store, list);
    }
  }

  const result: ProductComparison[] = [];
  for (const [key, entry] of byProduct) {
    if (entry.stores.size < 2) continue;
    const stores: StorePriceStats[] = [...entry.stores.entries()].map(([store, points]) => {
      const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
      const last = sorted[sorted.length - 1];
      return {
        store,
        lastPrice: Math.round(last.price),
        avgPrice: Math.round(points.reduce((s, x) => s + x.price, 0) / points.length),
        lastDate: last.date,
        count: points.length,
      };
    });
    stores.sort((a, b) => a.avgPrice - b.avgPrice);
    const cheapest = stores[0];
    const priciest = stores[stores.length - 1];
    result.push({
      key,
      name: entry.name,
      baseUnit: entry.baseUnit,
      unitLabel: unitLabelFor(entry.baseUnit),
      stores,
      cheapest,
      priciest,
      spreadPct: priciest.avgPrice > 0 ? Math.round(((priciest.avgPrice - cheapest.avgPrice) / priciest.avgPrice) * 100) : 0,
    });
  }
  return result.sort((a, b) => b.spreadPct - a.spreadPct);
}

/** canonical name (lowercase) -> comparison, for hints in the shopping list. */
export function indexComparisons(comparisons: ProductComparison[]): Map<string, ProductComparison> {
  const map = new Map<string, ProductComparison>();
  for (const c of comparisons) {
    const k = keyOf(c.name);
    const prev = map.get(k);
    // Same name with two base units (rare): keep the one with more data
    if (!prev || c.stores.reduce((s, x) => s + x.count, 0) > prev.stores.reduce((s, x) => s + x.count, 0)) map.set(k, c);
  }
  return map;
}

/**
 * "Si hubieras comprado todo en el más barato, ahorrabas ₡X este mes": for every line bought this
 * month in a store that isn't the cheapest, the difference against the cheapest store's average.
 */
export function potentialSavingsThisMonth(purchases: Purchase[], comparisons: ProductComparison[]): { total: number; items: number } {
  const month = getCurrentMonthPrefix();
  const byKey = new Map(comparisons.map((c) => [c.key, c]));
  let total = 0;
  let items = 0;
  for (const p of purchases) {
    if (!p.purchaseDate.startsWith(month)) continue;
    for (const item of p.items) {
      const comp = byKey.get(`${keyOf(item.canonicalName || item.normalizedName)}|${item.baseUnit}`);
      const paid = pricePerStandardUnit(item);
      if (!comp || paid === null || comp.cheapest.store === p.supermarket.trim()) continue;
      const diff = paid - comp.cheapest.avgPrice;
      if (diff <= 0) continue;
      const qtyInStandardUnits = item.baseUnit === 'units' ? item.baseUnitQuantity : item.baseUnitQuantity / 1000;
      total += diff * qtyInStandardUnits;
      items += 1;
    }
  }
  return { total: Math.round(total), items };
}
