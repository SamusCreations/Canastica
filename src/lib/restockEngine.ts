// ============================================================================
// Canastica AI Restock Prediction & Base Unit Normalization Engine (ES / EN)
// ============================================================================

import {
  BaseUnit,
  ConfidenceLevel,
  GroceryCategory,
  HistoricalIntervalPoint,
  LanguageCode,
  Purchase,
  RestockPrediction,
  UnpredictedProductProgress,
} from '../types/grocery';
import { getTodayIso } from '../utils/dates';

export interface NormalizedUnitResult {
  baseUnitQuantity: number;
  baseUnit: BaseUnit;
  displayLabel: string;
}

/**
 * Converts varied grocery packaging units into a unified base unit:
 * - Volume -> 'ml' (e.g., 1 gal = 3,785 ml; 1 L = 1,000 ml; 2 x 900ml = 1,800 ml)
 * - Weight -> 'g'  (e.g., 1 kg = 1,000 g; 1 lb = 453.6 g; 16 oz = 453.6 g)
 * - Count  -> 'units' (e.g., 1 dozen = 12 units)
 */
export function normalizeToBaseUnit(
  quantity: number,
  unitString: string,
  productNameHint = ''
): NormalizedUnitResult {
  const combined = `${unitString} ${productNameHint}`.toLowerCase().trim();

  const embeddedSizeMatch = combined.match(
    /(\d+(?:\.\d+)?)\s*(ml|l|litro|litros|liter|liters|gal|galon|gallon|gallons|kg|kilo|kilos|g|gr|gram|grams|lb|lbs|oz|fl\s*oz|doz|docena|dozen|ct|pack|u|unid)/i
  );

  const unitRaw = unitString.toLowerCase().trim();

  if (
    unitRaw === 'gal' ||
    unitRaw === 'galon' ||
    unitRaw === 'galón' ||
    unitRaw === 'gallon' ||
    /\b1\s*gal/i.test(combined)
  ) {
    const ml = Math.round(quantity * 3785);
    return {
      baseUnitQuantity: ml,
      baseUnit: 'ml',
      displayLabel: `${quantity} gal (${ml.toLocaleString('es-CR')} ml)`,
    };
  }
  if (unitRaw === 'l' || unitRaw === 'litro' || unitRaw === 'litros' || unitRaw === 'liter') {
    const ml = Math.round(quantity * 1000);
    return {
      baseUnitQuantity: ml,
      baseUnit: 'ml',
      displayLabel: `${quantity} L (${ml.toLocaleString('es-CR')} ml)`,
    };
  }
  if (unitRaw === 'ml') {
    const ml = Math.round(quantity);
    return {
      baseUnitQuantity: ml,
      baseUnit: 'ml',
      displayLabel: `${ml.toLocaleString('es-CR')} ml`,
    };
  }
  if (unitRaw.includes('900ml') || /900\s*ml/i.test(combined)) {
    const ml = Math.round(quantity * 900);
    return {
      baseUnitQuantity: ml,
      baseUnit: 'ml',
      displayLabel: `${quantity} × 900ml (${ml.toLocaleString('es-CR')} ml)`,
    };
  }

  if (unitRaw === 'kg' || unitRaw === 'kilo' || unitRaw === 'kilos') {
    const g = Math.round(quantity * 1000);
    return {
      baseUnitQuantity: g,
      baseUnit: 'g',
      displayLabel: `${quantity} kg (${g.toLocaleString('es-CR')} g)`,
    };
  }
  if (unitRaw === 'lb' || unitRaw === 'lbs' || unitRaw === 'libra') {
    const g = Math.round(quantity * 453.6);
    return {
      baseUnitQuantity: g,
      baseUnit: 'g',
      displayLabel: `${quantity} lb (${g.toLocaleString('es-CR')} g)`,
    };
  }
  if (unitRaw === 'oz' || unitRaw === 'onza') {
    const g = Math.round(quantity * 28.35);
    return {
      baseUnitQuantity: g,
      baseUnit: 'g',
      displayLabel: `${quantity} oz (${g.toLocaleString('es-CR')} g)`,
    };
  }
  if (unitRaw === 'g' || unitRaw === 'gr' || unitRaw === 'gramos') {
    const g = Math.round(quantity);
    return {
      baseUnitQuantity: g,
      baseUnit: 'g',
      displayLabel: `${g.toLocaleString('es-CR')} g`,
    };
  }

  if (embeddedSizeMatch) {
    const val = parseFloat(embeddedSizeMatch[1]);
    const u = embeddedSizeMatch[2].toLowerCase();
    if (u === 'l' || u === 'litro' || u === 'litros' || u === 'liter') {
      const ml = Math.round(quantity * val * 1000);
      return {
        baseUnitQuantity: ml,
        baseUnit: 'ml',
        displayLabel: `${quantity} × ${val}L (${ml.toLocaleString('es-CR')} ml)`,
      };
    }
    if (u === 'ml') {
      const ml = Math.round(quantity * val);
      return {
        baseUnitQuantity: ml,
        baseUnit: 'ml',
        displayLabel: `${quantity} × ${val}ml (${ml.toLocaleString('es-CR')} ml)`,
      };
    }
    if (u === 'gal' || u === 'galon' || u === 'gallon') {
      const ml = Math.round(quantity * val * 3785);
      return {
        baseUnitQuantity: ml,
        baseUnit: 'ml',
        displayLabel: `${quantity} × ${val}gal (${ml.toLocaleString('es-CR')} ml)`,
      };
    }
    if (u === 'kg' || u === 'kilo' || u === 'kilos') {
      const g = Math.round(quantity * val * 1000);
      return {
        baseUnitQuantity: g,
        baseUnit: 'g',
        displayLabel: `${quantity} × ${val}kg (${g.toLocaleString('es-CR')} g)`,
      };
    }
    if (u === 'g' || u === 'gr' || u === 'gram') {
      const g = Math.round(quantity * val);
      return {
        baseUnitQuantity: g,
        baseUnit: 'g',
        displayLabel: `${quantity} × ${val}g (${g.toLocaleString('es-CR')} g)`,
      };
    }
  }

  if (unitRaw === 'dozen' || unitRaw === 'docena' || unitRaw === 'doz') {
    const units = Math.round(quantity * 12);
    return {
      baseUnitQuantity: units,
      baseUnit: 'units',
      displayLabel: `${quantity} docena (${units} u)`,
    };
  }

  return {
    baseUnitQuantity: quantity,
    baseUnit: 'units',
    displayLabel: `${quantity} ${unitString || 'unid'}`,
  };
}

const PRODUCT_KNOWLEDGE_BASE: {
  patterns: RegExp[];
  normalizedDefault: string;
  canonicalName: string;
  category: GroceryCategory;
  baseUnit: BaseUnit;
  shelfLifeDays: number;
  storageLocation: 'Fridge' | 'Freezer' | 'Dry Pantry' | 'Household';
}[] = [
  {
    patterns: [/lch\s*dos\s*pin/i, /leche\s*pinito/i, /leche/i, /\bmilk\b/i],
    normalizedDefault: 'Leche Dos Pinos 1L',
    canonicalName: 'Leche',
    category: 'Dairy & Eggs',
    baseUnit: 'ml',
    shelfLifeDays: 10,
    storageLocation: 'Fridge',
  },
  {
    patterns: [/huev/i, /\beggs?\b/i, /carton\s*huev/i],
    normalizedDefault: 'Huevos de Granja 12u',
    canonicalName: 'Huevos',
    category: 'Dairy & Eggs',
    baseUnit: 'units',
    shelfLifeDays: 21,
    storageLocation: 'Fridge',
  },
  {
    patterns: [/pech\s*pollo/i, /pollo/i, /chicken\s*breast/i, /\bchicken\b/i],
    normalizedDefault: 'Pechuga de Pollo Deshuesada',
    canonicalName: 'Pechuga de Pollo',
    category: 'Meat & Poultry',
    baseUnit: 'g',
    shelfLifeDays: 4,
    storageLocation: 'Fridge',
  },
  {
    patterns: [/carne\s*mol/i, /ground\s*beef/i, /res\s*molida/i, /lomito/i, /ribeye/i],
    normalizedDefault: 'Carne Molida Premium',
    canonicalName: 'Carne de Res',
    category: 'Meat & Poultry',
    baseUnit: 'g',
    shelfLifeDays: 4,
    storageLocation: 'Fridge',
  },
  {
    patterns: [/pan\s*bimbo/i, /pan\s*int/i, /whole\s*wheat\s*bread/i, /pan\s*artesanal/i, /\bbread\b/i, /\bpan\b/i],
    normalizedDefault: 'Pan Integral Artesanal 680g',
    canonicalName: 'Pan Integral',
    category: 'Bakery',
    baseUnit: 'g',
    shelfLifeDays: 6,
    storageLocation: 'Dry Pantry',
  },
  {
    patterns: [/det\s*ariel/i, /detergente/i, /laundry\s*detergent/i, /tide\s*liq/i],
    normalizedDefault: 'Detergente Líquido Ariel 2L',
    canonicalName: 'Detergente Líquido',
    category: 'Cleaning & Home',
    baseUnit: 'ml',
    shelfLifeDays: 365,
    storageLocation: 'Household',
  },
  {
    patterns: [/cafe\s*1820/i, /cafe\s*britt/i, /coffee\s*beans/i, /\bcoffee\b/i, /\bcaf[eé]\b/i],
    normalizedDefault: 'Café Molido 1820 / Britt 500g',
    canonicalName: 'Café en Grano / Molido',
    category: 'Beverages',
    baseUnit: 'g',
    shelfLifeDays: 90,
    storageLocation: 'Dry Pantry',
  },
  {
    patterns: [/aguacat/i, /\bavocados?\b/i],
    normalizedDefault: 'Aguacate Hass 1kg',
    canonicalName: 'Aguacate Hass',
    category: 'Produce',
    baseUnit: 'g',
    shelfLifeDays: 5,
    storageLocation: 'Fridge',
  },
  {
    patterns: [/yog\s*grieg/i, /greek\s*yogurt/i, /\byogurt?\b/i],
    normalizedDefault: 'Yogurt Griego Dos Pinos 1kg',
    canonicalName: 'Yogurt Griego',
    category: 'Dairy & Eggs',
    baseUnit: 'g',
    shelfLifeDays: 12,
    storageLocation: 'Fridge',
  },
  {
    patterns: [/arroz\s*tio\s*pel/i, /\brice\b/i, /arroz/i],
    normalizedDefault: 'Arroz Tío Pelón 99% Grano Entero 2kg',
    canonicalName: 'Arroz Blanco',
    category: 'Pantry Staples',
    baseUnit: 'g',
    shelfLifeDays: 365,
    storageLocation: 'Dry Pantry',
  },
  {
    patterns: [/aceit\s*oliv/i, /olive\s*oil/i],
    normalizedDefault: 'Aceite de Oliva Extra Virgen 750ml',
    canonicalName: 'Aceite de Oliva',
    category: 'Pantry Staples',
    baseUnit: 'ml',
    shelfLifeDays: 365,
    storageLocation: 'Dry Pantry',
  },
  {
    patterns: [/banan/i, /platan/i],
    normalizedDefault: 'Banano Criollo Orgánico',
    canonicalName: 'Bananos',
    category: 'Produce',
    baseUnit: 'g',
    shelfLifeDays: 5,
    storageLocation: 'Dry Pantry',
  },
  {
    patterns: [/pap\s*tost/i, /potato\s*chips/i, /tortilla\s*chips/i, /\bsnacks?\b/i],
    normalizedDefault: 'Papas Tostadas Artesanales 250g',
    canonicalName: 'Snacks y Papas',
    category: 'Snacks',
    baseUnit: 'g',
    shelfLifeDays: 60,
    storageLocation: 'Dry Pantry',
  },
  {
    patterns: [/jab\s*lavap/i, /dish\s*soap/i, /axion/i],
    normalizedDefault: 'Jabón Lavaplatos Líquido 750ml',
    canonicalName: 'Jabón Lavaplatos',
    category: 'Cleaning & Home',
    baseUnit: 'ml',
    shelfLifeDays: 365,
    storageLocation: 'Household',
  },
  {
    patterns: [/ques\s*turr/i, /mozzarella/i, /cheddar/i, /\bcheese\b/i, /\bqueso\b/i],
    normalizedDefault: 'Queso Turrialba Fresco 500g',
    canonicalName: 'Queso Fresco',
    category: 'Dairy & Eggs',
    baseUnit: 'g',
    shelfLifeDays: 14,
    storageLocation: 'Fridge',
  },
];

export function normalizeReceiptProduct(rawText: string) {
  const cleaned = rawText.trim();
  for (const entry of PRODUCT_KNOWLEDGE_BASE) {
    if (entry.patterns.some((rx) => rx.test(cleaned))) {
      return {
        normalizedName:
          /^[A-Z0-9\s.\-/]+$/.test(cleaned) && cleaned.length <= 24
            ? entry.normalizedDefault
            : cleaned,
        canonicalName: entry.canonicalName,
        category: entry.category,
        baseUnit: entry.baseUnit,
        shelfLifeDays: entry.shelfLifeDays,
        storageLocation: entry.storageLocation,
      };
    }
  }

  return {
    normalizedName: cleaned
      .toLowerCase()
      .replace(/\b\w/g, (l) => l.toUpperCase()),
    canonicalName:
      cleaned
        .replace(/\d+(?:\.\d+)?\s*(ml|l|g|kg|oz|lb|gal|ct|pack|u)/gi, '')
        .trim()
        .replace(/\b\w/g, (l) => l.toUpperCase()) || 'Producto Supermercado',
    category: 'Pantry Staples' as GroceryCategory,
    baseUnit: 'units' as BaseUnit,
    shelfLifeDays: 14,
    storageLocation: 'Dry Pantry' as const,
  };
}

function daysBetween(dateA: string, dateB: string): number {
  const a = new Date(`${dateA}T00:00:00`).getTime();
  const b = new Date(`${dateB}T00:00:00`).getTime();
  return Math.round((b - a) / (1000 * 60 * 60 * 24));
}

function formatBaseQtyHuman(qty: number, unit: BaseUnit): string {
  if (unit === 'ml') {
    if (qty >= 1000) {
      return `${(qty / 1000).toFixed(qty % 1000 === 0 ? 0 : 1)} L (${qty.toLocaleString('es-CR')} ml)`;
    }
    return `${Math.round(qty).toLocaleString('es-CR')} ml`;
  }
  if (unit === 'g') {
    if (qty >= 1000) {
      return `${(qty / 1000).toFixed(qty % 1000 === 0 ? 0 : 2)} kg (${qty.toLocaleString('es-CR')} g)`;
    }
    return `${Math.round(qty).toLocaleString('es-CR')} g`;
  }
  return `${Math.round(qty)} unid`;
}

export interface RestockAnalysisOutput {
  predictions: RestockPrediction[];
  learningProducts: UnpredictedProductProgress[];
}

export function calculateRestockPredictions(
  purchases: Purchase[],
  options: {
    lookbackMonths: 3 | 6 | 12;
    alertThresholdDays: number;
    minPurchases: number;
    feedbackMultipliers: Record<string, number>;
    language?: LanguageCode;
    referenceDate?: string;
  }
): RestockAnalysisOutput {
  const lang = options.language || 'es';
  const todayStr = options.referenceDate || getTodayIso();
  const cutoffDate = new Date(`${todayStr}T00:00:00`);
  cutoffDate.setMonth(cutoffDate.getMonth() - options.lookbackMonths);
  const cutoffIso = cutoffDate.toISOString().slice(0, 10);

  const productBuckets = new Map<
    string,
    {
      canonicalName: string;
      category: GroceryCategory;
      baseUnit: BaseUnit;
      variants: Set<string>;
      byDate: Map<
        string,
        {
          date: string;
          baseQuantity: number;
          displayParts: string[];
        }
      >;
    }
  >();

  for (const purchase of purchases) {
    if (purchase.purchaseDate < cutoffIso) continue;
    for (const item of purchase.items) {
      const key = item.canonicalName.trim();
      if (!productBuckets.has(key)) {
        productBuckets.set(key, {
          canonicalName: key,
          category: item.category,
          baseUnit: item.baseUnit,
          variants: new Set<string>(),
          byDate: new Map(),
        });
      }
      const bucket = productBuckets.get(key)!;
      bucket.variants.add(item.normalizedName);

      const existingOnDate = bucket.byDate.get(purchase.purchaseDate);
      if (existingOnDate) {
        existingOnDate.baseQuantity += item.baseUnitQuantity;
      } else {
        bucket.byDate.set(purchase.purchaseDate, {
          date: purchase.purchaseDate,
          baseQuantity: item.baseUnitQuantity,
          displayParts: [`${item.quantity} ${item.unit}`],
        });
      }
    }
  }

  const predictions: RestockPrediction[] = [];
  const learningProducts: UnpredictedProductProgress[] = [];

  for (const bucket of productBuckets.values()) {
    const sortedEvents = Array.from(bucket.byDate.values()).sort((a, b) =>
      a.date.localeCompare(b.date)
    );

    if (sortedEvents.length < options.minPurchases) {
      learningProducts.push({
        canonicalName: bucket.canonicalName,
        category: bucket.category,
        purchaseCount: sortedEvents.length,
        requiredCount: options.minPurchases,
        groupedVariants: Array.from(bucket.variants),
        lastPurchaseDate: sortedEvents[sortedEvents.length - 1]?.date || todayStr,
      });
      continue;
    }

    const intervals: HistoricalIntervalPoint[] = [];
    let weightedRateSum = 0;
    let weightSum = 0;
    const rawRates: number[] = [];

    for (let i = 0; i < sortedEvents.length - 1; i++) {
      const current = sortedEvents[i];
      const next = sortedEvents[i + 1];
      const elapsed = Math.max(1, daysBetween(current.date, next.date));
      const dailyRate = current.baseQuantity / elapsed;
      const recencyWeight = Number(Math.pow(1.5, i).toFixed(2));

      intervals.push({
        purchaseDate: current.date,
        nextPurchaseDate: next.date,
        daysElapsed: elapsed,
        baseQuantityBought: current.baseQuantity,
        displayQuantity: formatBaseQtyHuman(current.baseQuantity, bucket.baseUnit),
        dailyRateInInterval: Number(dailyRate.toFixed(1)),
        recencyWeight,
      });

      weightedRateSum += dailyRate * recencyWeight;
      weightSum += recencyWeight;
      rawRates.push(dailyRate);
    }

    const feedbackMultiplier = options.feedbackMultipliers[bucket.canonicalName] ?? 1.0;
    const weightedDailyRate = Math.max(
      0.01,
      (weightedRateSum / Math.max(0.01, weightSum)) * feedbackMultiplier
    );

    const lastEvent = sortedEvents[sortedEvents.length - 1];
    const expectedDurationDays = lastEvent.baseQuantity / weightedDailyRate;
    const daysSinceLast = Math.max(0, daysBetween(lastEvent.date, todayStr));
    const estimatedDaysRemaining = Math.max(
      0,
      Number((expectedDurationDays - daysSinceLast).toFixed(1))
    );

    const meanRate = rawRates.reduce((acc, r) => acc + r, 0) / rawRates.length;
    const variance =
      rawRates.reduce((acc, r) => acc + Math.pow(r - meanRate, 2), 0) / rawRates.length;
    const stdDev = Math.sqrt(variance);
    const cv = meanRate > 0 ? stdDev / meanRate : 1;

    let confidenceLevel: ConfidenceLevel = 'medium';
    let confidenceScore = Math.round(
      Math.max(45, Math.min(98, (1 - cv * 0.75) * 85 + Math.min(15, sortedEvents.length * 3)))
    );
    if (cv <= 0.2 && sortedEvents.length >= 4) {
      confidenceLevel = 'high';
      confidenceScore = Math.max(88, confidenceScore);
    } else if (cv > 0.42) {
      confidenceLevel = 'low';
      confidenceScore = Math.min(62, confidenceScore);
    }

    const humanLastQty = formatBaseQtyHuman(lastEvent.baseQuantity, bucket.baseUnit);
    const roundedRate =
      bucket.baseUnit === 'units'
        ? Number(weightedDailyRate.toFixed(1))
        : Math.round(weightedDailyRate);
    const roundedRemaining = Math.round(estimatedDaysRemaining);
    const unitLabel = bucket.baseUnit === 'units' ? (lang === 'es' ? 'unid' : 'units') : bucket.baseUnit;

    const aiExplanation =
      lang === 'es'
        ? estimatedDaysRemaining <= 0.4
          ? `Compraste ${humanLastQty} de ${bucket.canonicalName.toLowerCase()} hace ${daysSinceLast} días; al ritmo habitual del hogar de ${roundedRate} ${unitLabel}/día, se estima que se agota hoy.`
          : `Compraste ${humanLastQty} de ${bucket.canonicalName.toLowerCase()} hace ${daysSinceLast} días; al ritmo habitual del hogar (${roundedRate} ${unitLabel}/día), te queda para unos ${roundedRemaining} ${roundedRemaining === 1 ? 'día' : 'días'}.`
        : estimatedDaysRemaining <= 0.4
        ? `You bought ${humanLastQty} of ${bucket.canonicalName.toLowerCase()} ${daysSinceLast} days ago; at your household's pace of ${roundedRate} ${unitLabel}/day, it runs out today.`
        : `You bought ${humanLastQty} of ${bucket.canonicalName.toLowerCase()} ${daysSinceLast} days ago; at your household's usual pace of ${roundedRate} ${unitLabel}/day, you have about ${roundedRemaining} ${roundedRemaining === 1 ? 'day' : 'days'} left.`;

    predictions.push({
      canonicalName: bucket.canonicalName,
      category: bucket.category,
      baseUnit: bucket.baseUnit,
      weightedDailyRate: Number(weightedDailyRate.toFixed(1)),
      lastPurchaseDate: lastEvent.date,
      daysSinceLastPurchase: daysSinceLast,
      lastPurchaseBaseQty: lastEvent.baseQuantity,
      lastPurchaseDisplayQty: humanLastQty,
      expectedDurationDays: Number(expectedDurationDays.toFixed(1)),
      estimatedDaysRemaining,
      confidenceLevel,
      confidenceScore,
      purchaseCount: sortedEvents.length,
      groupedVariants: Array.from(bucket.variants),
      intervals,
      feedbackMultiplier,
      aiExplanation,
      isRunningLowSoon: estimatedDaysRemaining <= options.alertThresholdDays,
    });
  }

  predictions.sort((a, b) => a.estimatedDaysRemaining - b.estimatedDaysRemaining);

  return { predictions, learningProducts };
}
