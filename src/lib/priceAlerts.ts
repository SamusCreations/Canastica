// ============================================================================
// Price rise alerts, computed locally when a receipt is saved:
// each usual product (bought at least 3 times before) is compared with its
// average price per kg / L / unit in the same store over the last 6 months.
// Promotional lines are ignored on both sides so a promo ending isn't a "rise".
// ============================================================================

import type { Purchase, PurchaseItem } from '../types/grocery';
import { addDaysIso } from '../utils/dates';
import { pricePerStandardUnit, unitLabelFor } from './priceComparison';

export const DEFAULT_PRICE_ALERT_THRESHOLD = 10;
const LOOKBACK_DAYS = 183;
const MIN_PREVIOUS_PURCHASES = 3;

export interface PriceAlert {
  id: string;
  purchaseId?: string;
  canonicalName: string;
  productName: string;
  supermarket: string;
  previousPrice: number;
  newPrice: number;
  unitLabel: string;
  changePct: number;
  seen: boolean;
  createdAt: string;
}

const keyOf = (s: string) => s.trim().toLowerCase();

/** A line paid below its listed price (PROMO folded into the line) */
export function isPromoLine(item: PurchaseItem): boolean {
  return item.unitPrice > 0 && item.quantity > 0 && item.totalPrice < item.unitPrice * item.quantity - 1;
}

export function computePriceAlerts(
  newPurchase: Purchase,
  previousPurchases: Purchase[],
  thresholdPct: number,
  mutedCanonicalNames: Set<string>,
  makeId: () => string
): PriceAlert[] {
  const since = addDaysIso(newPurchase.purchaseDate, -LOOKBACK_DAYS);
  const store = keyOf(newPurchase.supermarket);
  const others = previousPurchases.filter((p) => p.id !== newPurchase.id);
  const alerts: PriceAlert[] = [];
  const seenKeys = new Set<string>();

  for (const item of newPurchase.items) {
    const canonical = keyOf(item.canonicalName || item.normalizedName);
    if (!canonical || mutedCanonicalNames.has(canonical) || seenKeys.has(canonical)) continue;
    if (isPromoLine(item)) continue;
    const newPrice = pricePerStandardUnit(item);
    if (newPrice === null) continue;

    // Usual product: bought in at least 3 earlier receipts (any store)
    const timesBought = others.filter((p) => p.items.some((i) => keyOf(i.canonicalName || i.normalizedName) === canonical)).length;
    if (timesBought < MIN_PREVIOUS_PURCHASES) continue;

    const history = others
      .filter((p) => keyOf(p.supermarket) === store && p.purchaseDate >= since && p.purchaseDate <= newPurchase.purchaseDate)
      .flatMap((p) => p.items)
      .filter((i) => keyOf(i.canonicalName || i.normalizedName) === canonical && i.baseUnit === item.baseUnit && !isPromoLine(i))
      .map(pricePerStandardUnit)
      .filter((v): v is number => v !== null);
    if (history.length === 0) continue;

    const avg = history.reduce((s, v) => s + v, 0) / history.length;
    const changePct = ((newPrice - avg) / avg) * 100;
    if (changePct < thresholdPct) continue;

    seenKeys.add(canonical);
    alerts.push({
      id: makeId(),
      purchaseId: newPurchase.id,
      canonicalName: item.canonicalName || item.normalizedName,
      productName: item.normalizedName || item.canonicalName,
      supermarket: newPurchase.supermarket,
      previousPrice: Math.round(avg),
      newPrice: Math.round(newPrice),
      unitLabel: unitLabelFor(item.baseUnit),
      changePct: Math.round(changePct),
      seen: false,
      createdAt: new Date().toISOString(),
    });
  }
  return alerts;
}
