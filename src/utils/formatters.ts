// ============================================================================
// Canastica Currency (CRC ₡ / USD $) & Bilingual Localization Helpers (ES / EN)
// ============================================================================

import {
  ConfidenceLevel,
  CurrencyCode,
  GroceryCategory,
  LanguageCode,
  StorageLocation,
} from '../types/grocery';

export const CRC_TO_USD_RATE = 515; // 1 USD ≈ 515 CRC

/**
 * Formats an amount stored in CRC into either CRC (₡) or USD ($)
 */
export function formatCurrency(
  amountCRC: number,
  currency: CurrencyCode = 'CRC',
  compact = false
): string {
  const safeVal = Number.isFinite(amountCRC) ? amountCRC : 0;

  if (currency === 'USD') {
    const usd = safeVal / CRC_TO_USD_RATE;
    if (compact && Math.abs(usd) >= 1000) {
      return `$${(usd / 1000).toFixed(1)}k`;
    }
    return `$${usd.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  }

  // Default: Costa Rican Colones (CRC ₡)
  const rounded = Math.round(safeVal);
  if (compact && Math.abs(rounded) >= 1000000) {
    return `₡${(rounded / 1000000).toFixed(2)}M`;
  }
  return `₡${rounded.toLocaleString('es-CR')}`;
}

const CATEGORY_ES_MAP: Record<GroceryCategory, string> = {
  'Dairy & Eggs': 'Lácteos y Huevos',
  'Meat & Poultry': 'Carnes y Aves',
  Produce: 'Frutas y Verduras',
  Bakery: 'Panadería',
  'Pantry Staples': 'Abarrotes y Despensa',
  Beverages: 'Bebidas y Café',
  Snacks: 'Snacks y Golosinas',
  'Cleaning & Home': 'Limpieza y Hogar',
  'Personal Care': 'Cuidado Personal',
};

export function translateCategory(cat: GroceryCategory, lang: LanguageCode = 'es'): string {
  if (lang === 'en') return cat;
  return CATEGORY_ES_MAP[cat] || cat;
}

const STORAGE_ES_MAP: Record<StorageLocation, string> = {
  Fridge: 'Refrigeradora',
  Freezer: 'Congelador',
  'Dry Pantry': 'Alacena Seca',
  Household: 'Limpieza / Hogar',
};

export function translateStorage(loc: StorageLocation, lang: LanguageCode = 'es'): string {
  if (lang === 'en') return loc;
  return STORAGE_ES_MAP[loc] || loc;
}

export function translateConfidence(level: ConfidenceLevel, lang: LanguageCode = 'es'): string {
  if (lang === 'en') return `${level} confidence`;
  if (level === 'high') return 'Confianza Alta';
  if (level === 'medium') return 'Confianza Media';
  return 'Confianza Baja';
}
