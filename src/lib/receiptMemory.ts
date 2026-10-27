// ============================================================================
// Receipt memory: reuse what the household already confirmed for a receipt line.
// Store receipts (e.g. Palí) print the same abbreviated description for the same
// product every time ("LECHE DOS P"), so once someone corrects the name or the
// presentation, later scans of that line pick it up automatically.
// ============================================================================

import { GroceryCategory, Purchase, PurchaseItem } from '../types/grocery';

export function receiptNameKey(raw: string): string {
  return raw
    .toUpperCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

export type ReceiptMemory = Map<string, PurchaseItem>;

/** Latest confirmed item per receipt description, ignoring manual entries. */
export function buildReceiptMemory(purchases: Purchase[]): ReceiptMemory {
  const memory: ReceiptMemory = new Map();
  const sorted = [...purchases].sort((a, b) => a.purchaseDate.localeCompare(b.purchaseDate));
  for (const purchase of sorted) {
    for (const item of purchase.items) {
      const key = receiptNameKey(item.rawReceiptName || '');
      if (!key || key === 'MANUAL') continue;
      memory.set(key, item);
    }
  }
  return memory;
}

interface RememberableDraft {
  rawReceiptName: string;
  normalizedName: string;
  canonicalName: string;
  category: GroceryCategory;
  unit: string;
  pricingMode?: 'unit' | 'multi' | 'weight';
  sizeKnown?: boolean;
}

/** Returns the draft with names/category (and presentation, when the receipt lacks it) from history. */
export function applyReceiptMemory<T extends RememberableDraft>(
  draft: T,
  memory: ReceiptMemory
): T & { learnedFromHistory: boolean } {
  const known = memory.get(receiptNameKey(draft.rawReceiptName));
  if (!known) return { ...draft, learnedFromHistory: false };

  const reusePresentation =
    draft.pricingMode !== 'weight' && !draft.sizeKnown && /\d/.test(known.unit) && !/kg/i.test(known.unit);

  return {
    ...draft,
    normalizedName: known.normalizedName || draft.normalizedName,
    canonicalName: known.canonicalName || draft.canonicalName,
    category: known.category || draft.category,
    unit: reusePresentation ? known.unit : draft.unit,
    sizeKnown: draft.sizeKnown || reusePresentation || /\d\s*(ml|l|g|kg|gal|oz)\b/i.test(known.normalizedName),
    learnedFromHistory: true,
  };
}
