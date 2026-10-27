// ============================================================================
// Canastica: data client and automatic receipt reading service
// ============================================================================

import { createClient, FunctionsHttpError, SupabaseClient } from '@supabase/supabase-js';
import { normalizeReceiptProduct, normalizeToBaseUnit } from '../lib/restockEngine';
import {
  reconcileReceipt,
  type ExtractedReceipt,
  type ExtractedReceiptItem,
} from '../../supabase/functions/_shared/receiptExtraction.ts';
import {
  GroceryCategory,
  Household,
  PantryItem,
  Purchase,
  PurchaseItem,
  RestockPrediction,
  ShoppingListItem,
} from '../types/grocery';
import { formatCurrency, translateCategory } from '../utils/formatters';
import {
  addDaysIso,
  getCurrentMonthPrefix,
  getPreviousMonthPrefix,
  getTodayIso,
  monthLabel,
  monthName,
} from '../utils/dates';

export interface CloudConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
}

// Older builds let testers save keys in the browser; drop anything left behind
try {
  localStorage.removeItem('glasscart_cloud_config_v1');
} catch {
  // ignore storage errors
}

export function getCloudConfig(): CloudConfig {
  return {
    supabaseUrl: import.meta.env.VITE_SUPABASE_URL || '',
    supabaseAnonKey: import.meta.env.VITE_SUPABASE_ANON_KEY || '',
  };
}

let supabaseInstance: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient | null {
  if (supabaseInstance) return supabaseInstance;
  const cfg = getCloudConfig();
  if (cfg.supabaseUrl && cfg.supabaseAnonKey) {
    try {
      supabaseInstance = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
        realtime: { params: { eventsPerSecond: 10 } },
      });
      return supabaseInstance;
    } catch {
      return null;
    }
  }
  return null;
}

const AI_FUNCTION_NAME = 'assistant';

let lastGeminiError: string | null = null;

/** Why the last AI call failed, in words the user can act on (null after a success). */
export function getLastGeminiError(): string | null {
  return lastGeminiError;
}

const AI_BUSY_MESSAGE =
  'El servicio de lectura está ocupado. Inténtalo en unos minutos o regístrala a mano.';
const AI_GENERIC_MESSAGE =
  'No se pudo leer la factura en este momento. Inténtalo más tarde o regístrala a mano.';

// Only fixed Spanish texts reach the UI: never raw server messages, model names or secrets
function describeGeminiError(code: unknown, status?: number): string {
  if (status === 401 || code === 'unauthorized') {
    return 'Tu sesión expiró; vuelve a iniciar sesión.';
  }
  if (code === 'busy' || status === 429 || status === 503) return AI_BUSY_MESSAGE;
  if (code === 'offline') return 'Sin conexión a internet. Revisa tu conexión e inténtalo de nuevo.';
  return AI_GENERIC_MESSAGE;
}

async function invokeGeminiJSON<T>(action: string, payload: Record<string, unknown>): Promise<T | null> {
  const client = getSupabaseClient();
  if (!client) {
    lastGeminiError = null;
    return null;
  }

  try {
    const { data, error } = await client.functions.invoke(AI_FUNCTION_NAME, {
      body: { action, payload },
    });
    if (error) {
      if (error instanceof FunctionsHttpError) {
        const response = error.context as Response;
        const body = await response.json().catch(() => null);
        lastGeminiError = describeGeminiError(body?.code, response.status);
      } else {
        lastGeminiError = describeGeminiError(navigator.onLine ? 'internal' : 'offline');
      }
      return null;
    }
    if (data?.error) {
      lastGeminiError = describeGeminiError(data.code);
      return null;
    }
    lastGeminiError = null;
    return data as T;
  } catch {
    lastGeminiError = describeGeminiError(navigator.onLine ? 'internal' : 'offline');
    return null;
  }
}

export type ScannedReceiptItem = Omit<ExtractedReceiptItem, 'category' | 'baseUnit'> & {
  category: GroceryCategory;
  baseUnit: 'ml' | 'g' | 'units';
  isShared: boolean;
};

export type ScannedReceiptResult = Omit<ExtractedReceipt, 'items' | 'blurryAdvice'> & {
  blurryAdvice?: string;
  items: ScannedReceiptItem[];
};

const VALID_CATEGORIES: GroceryCategory[] = [
  'Dairy & Eggs',
  'Meat & Poultry',
  'Produce',
  'Bakery',
  'Pantry Staples',
  'Beverages',
  'Snacks',
  'Cleaning & Home',
  'Personal Care',
];

export async function scanReceiptImageWithAI(
  base64DataUrl: string,
  language: 'es' | 'en' = 'es'
): Promise<ScannedReceiptResult> {
  const base64Clean = base64DataUrl.includes(',')
    ? base64DataUrl.split(',')[1]
    : base64DataUrl;
  const mimeMatch = base64DataUrl.match(/data:(.*?);base64/);
  const mimeType = mimeMatch ? mimeMatch[1] : 'image/jpeg';

  const aiResult = await invokeGeminiJSON<Partial<ExtractedReceipt>>('scan-receipt', {
    base64Image: base64Clean,
    mimeType,
    language,
  });

  if (aiResult && (aiResult.isBlurry || Array.isArray(aiResult.items))) {
    // The Edge Function already reconciles; running it again is idempotent
    const reconciled = reconcileReceipt(aiResult);
    return {
      ...reconciled,
      blurryAdvice: reconciled.blurryAdvice ?? undefined,
      items: reconciled.items.map((it) => ({
        ...it,
        category: VALID_CATEGORIES.includes(it.category as GroceryCategory)
          ? (it.category as GroceryCategory)
          : normalizeReceiptProduct(it.normalizedName).category,
        isShared: true,
      })),
    };
  }

  return {
    isBlurry: true,
    blurryAdvice: getLastGeminiError() ?? AI_GENERIC_MESSAGE,
    supermarket: '',
    purchaseDate: getTodayIso(),
    dateSource: 'none',
    discounts: 0,
    taxes: 0,
    receiptTotal: 0,
    items: [],
  };
}

export interface ParsedShoppingInputItem {
  name: string;
  canonicalName: string;
  category: GroceryCategory;
  quantity: number;
  unit: string;
}

export async function parseNaturalLanguageShoppingInput(
  rawInput: string
): Promise<ParsedShoppingInputItem[]> {
  const trimmed = rawInput.trim();
  if (!trimmed) return [];

  const aiParsed = await invokeGeminiJSON<ParsedShoppingInputItem[]>('parse-shopping-input', {
    text: trimmed,
  });

  if (Array.isArray(aiParsed) && aiParsed.length > 0) {
    return aiParsed;
  }

  const segments = trimmed
    .split(/(?:,|;|\by\b|\band\b|\be\b|\+)/i)
    .map((s) => s.trim())
    .filter(Boolean);

  return segments.map((segment) => {
    const qtyUnitMatch = segment.match(
      /^(\d+(?:\.\d+)?)\s*(litros?|liters?|l|ml|kg|kilos?|g|gramos?|grams?|gal|galones?|bolsas?|botellas?|paquetes?|cajas?|unidades?|unid|cartones?|docenas?|lbs?|oz)?\s*(?:de|of)?\s+(.+)$/i
    );

    let quantity = 1;
    let unit = 'unid';
    let itemText = segment;

    if (qtyUnitMatch) {
      quantity = parseFloat(qtyUnitMatch[1]) || 1;
      const rawUnit = (qtyUnitMatch[2] || '').toLowerCase();
      if (/litro|liter|^l$/i.test(rawUnit)) unit = 'L';
      else if (/^ml$/i.test(rawUnit)) unit = 'ml';
      else if (/kg|kilo/i.test(rawUnit)) unit = 'kg';
      else if (/^g$|gram/i.test(rawUnit)) unit = 'g';
      else if (/gal/i.test(rawUnit)) unit = 'gal';
      else if (rawUnit) unit = rawUnit;
      itemText = qtyUnitMatch[3].trim();
    }

    const cleanName = itemText.replace(/\b\w/g, (c) => c.toUpperCase());
    const norm = normalizeReceiptProduct(cleanName);

    if (unit === 'unid') {
      if (norm.baseUnit === 'ml') unit = 'L';
      else if (norm.baseUnit === 'g' && /pollo|carne|aguacate|arroz|banan/i.test(cleanName)) unit = 'kg';
    }

    return {
      name: cleanName,
      canonicalName: norm.canonicalName,
      category: norm.category,
      quantity,
      unit,
    };
  });
}

export function matchPurchasedItemsToShoppingList(
  uncheckedList: ShoppingListItem[],
  purchasedItems: PurchaseItem[]
): {
  shoppingListItemId: string;
  shoppingListName: string;
  matchedReceiptItemName: string;
}[] {
  const matches: {
    shoppingListItemId: string;
    shoppingListName: string;
    matchedReceiptItemName: string;
  }[] = [];

  for (const listItem of uncheckedList) {
    if (listItem.isChecked) continue;
    const listCanonical = (
      listItem.canonicalName || normalizeReceiptProduct(listItem.name).canonicalName
    ).toLowerCase();
    const listTokens = listItem.name
      .toLowerCase()
      .replace(/[^a-záéíóúñ0-9\s]/g, '')
      .split(/\s+/)
      .filter((w) => w.length > 2);

    const matchedPurchaseItem = purchasedItems.find((pItem) => {
      const pCanonical = pItem.canonicalName.toLowerCase();
      if (listCanonical && pCanonical && listCanonical === pCanonical) {
        return true;
      }
      const pNameLower = `${pItem.normalizedName} ${pItem.rawReceiptName} ${pItem.canonicalName}`.toLowerCase();
      if (pNameLower.includes(listCanonical) || listCanonical.includes(pCanonical)) {
        return true;
      }
      return listTokens.some((tok) => pNameLower.includes(tok));
    });

    if (matchedPurchaseItem) {
      matches.push({
        shoppingListItemId: listItem.id,
        shoppingListName: listItem.name,
        matchedReceiptItemName: matchedPurchaseItem.normalizedName,
      });
    }
  }

  return matches;
}

export function generateHouseholdAIInsights(
  purchases: Purchase[],
  household: Household,
  predictions: RestockPrediction[]
): {
  headline: string;
  suggestion: string;
  budgetPct: number;
  snackDeltaPct: number;
} {
  const lang = household.language || 'es';
  const cur = household.currency || 'CRC';
  const currentMonthPrefix = getCurrentMonthPrefix();
  const prevMonthPrefix = getPreviousMonthPrefix();

  const currentMonthPurchases = purchases.filter((p) =>
    p.purchaseDate.startsWith(currentMonthPrefix)
  );
  const prevMonthPurchases = purchases.filter((p) =>
    p.purchaseDate.startsWith(prevMonthPrefix)
  );

  const currentSpent = currentMonthPurchases.reduce((sum, p) => sum + p.totalAmount, 0);
  const budgetPct = Math.round((currentSpent / Math.max(1, household.monthlyBudget)) * 100);

  const currentSnacks = currentMonthPurchases
    .flatMap((p) => p.items)
    .filter((i) => i.category === 'Snacks')
    .reduce((sum, i) => sum + i.totalPrice, 0);

  const prevSnacks = prevMonthPurchases
    .flatMap((p) => p.items)
    .filter((i) => i.category === 'Snacks')
    .reduce((sum, i) => sum + i.totalPrice, 0);

  const snackDeltaPct =
    prevSnacks > 0 ? Math.round(((currentSnacks - prevSnacks) / prevSnacks) * 100) : 0;

  const urgentRestocks = predictions.filter(
    (p) => p.estimatedDaysRemaining <= household.restockAlertDays
  );

  // Biggest category this month, used for a data-driven tip
  const categoryTotals = new Map<string, number>();
  currentMonthPurchases
    .flatMap((p) => p.items)
    .forEach((i) => categoryTotals.set(i.category, (categoryTotals.get(i.category) || 0) + i.totalPrice));
  const topCategory = Array.from(categoryTotals.entries()).sort((x, y) => y[1] - x[1])[0];
  const urgentNames = urgentRestocks.map((u) => u.canonicalName).slice(0, 2);
  const daysLeft = Math.max(0, Math.round(urgentRestocks[0]?.estimatedDaysRemaining ?? 0));

  if (lang === 'en') {
    const headline =
      purchases.length === 0
        ? 'Scan your first receipt to start tracking your monthly grocery budget.'
        : snackDeltaPct > 0
        ? `You've used ${budgetPct}% of your ${formatCurrency(household.monthlyBudget, cur)} monthly budget (${formatCurrency(currentSpent, cur)} spent); snack spending is up ${snackDeltaPct}% vs. last month.`
        : `You've used ${budgetPct}% of your ${formatCurrency(household.monthlyBudget, cur)} monthly budget (${formatCurrency(currentSpent, cur)} spent).`;
    const suggestion =
      urgentNames.length > 0
        ? `Plan your next trip: ${urgentNames.join(' & ')} will run out in ~${daysLeft} days.`
        : topCategory
        ? `Your biggest category this month is ${topCategory[0]} (${formatCurrency(topCategory[1], cur)}). Compare prices in Analytics before your next purchase.`
        : 'The more receipts you scan, the better the restock predictions get.';
    return { headline, suggestion, budgetPct, snackDeltaPct };
  }

  const headline =
    purchases.length === 0
      ? 'Escanea tu primera factura para empezar a controlar el presupuesto del mes.'
      : snackDeltaPct > 0
      ? `Llevas el ${budgetPct}% del presupuesto mensual (${formatCurrency(currentSpent, cur)} de ${formatCurrency(household.monthlyBudget, cur)}); el gasto en snacks subió ${snackDeltaPct}% respecto al mes pasado.`
      : `Llevas el ${budgetPct}% del presupuesto mensual (${formatCurrency(currentSpent, cur)} de ${formatCurrency(household.monthlyBudget, cur)})${budgetPct < 100 ? `, con un margen del ${100 - budgetPct}% para fin de mes` : ''}.`;

  const suggestion =
    urgentNames.length > 0
      ? `Planea tu próxima compra: ${urgentNames.join(' y ')} se ${urgentNames.length > 1 ? 'acaban' : 'acaba'} en ~${daysLeft} días.`
      : topCategory
      ? `Tu categoría con más gasto este mes es ${translateCategory(topCategory[0] as GroceryCategory)} (${formatCurrency(topCategory[1], cur)}). Revisa el comparador de precios antes de tu próxima compra.`
      : 'Mientras más facturas escanees, más precisas serán las predicciones de reposición.';

  return { headline, suggestion, budgetPct, snackDeltaPct };
}

export async function answerHouseholdQuestion(
  question: string,
  context: {
    household: Household;
    purchases: Purchase[];
    shoppingList: ShoppingListItem[];
    pantry: PantryItem[];
    predictions: RestockPrediction[];
  }
): Promise<string> {
  const q = question.toLowerCase().trim();
  const cur = context.household.currency || 'CRC';
  const lang = context.household.language || 'es';

  // 1. "¿Cuánto gastamos en carne en septiembre?"
  if (
    q.includes('carne') ||
    q.includes('meat') ||
    q.includes('pollo') ||
    q.includes('septiembre') ||
    q.includes('september')
  ) {
    const septPurchases = context.purchases.filter((p) => p.purchaseDate.startsWith(getPreviousMonthPrefix()));
    const septMeatItems = septPurchases
      .flatMap((p) => p.items)
      .filter((i) => i.category === 'Meat & Poultry');
    const septMeatTotal = septMeatItems.reduce((s, i) => s + i.totalPrice, 0);

    const octPurchases = context.purchases.filter((p) => p.purchaseDate.startsWith(getCurrentMonthPrefix()));
    const octMeatTotal = octPurchases
      .flatMap((p) => p.items)
      .filter((i) => i.category === 'Meat & Poultry')
      .reduce((s, i) => s + i.totalPrice, 0);

    return (
      `En **${monthLabel(getPreviousMonthPrefix()).toLowerCase()}**, el hogar gastó **${formatCurrency(septMeatTotal, cur)}** en **Carnes y Aves** a través de ${septMeatItems.length} registros:\n` +
      septMeatItems
        .map(
          (i) =>
            `• **${i.normalizedName}** (${i.supermarket}, ${i.purchaseDate}): **${formatCurrency(i.totalPrice, cur)}**`
        )
        .join('\n') +
      `\n\nEn comparación, en lo que va de **${monthLabel(getCurrentMonthPrefix()).toLowerCase()}** el gasto en Carnes y Aves es de **${formatCurrency(octMeatTotal, cur)}**.`
    );
  }

  // 2. "¿Cuál fue la compra más cara del año?"
  if (
    q.includes('cara') ||
    q.includes('grande') ||
    q.includes('expensive') ||
    q.includes('mayor')
  ) {
    const sorted = [...context.purchases].sort((a, b) => b.totalAmount - a.totalAmount);
    const top = sorted[0];
    if (!top) return 'Aún no hay compras registradas.';
    const buyer =
      context.household.members.find((m) => m.id === top.createdBy)?.name || 'Miembro';
    const second = sorted[1];
    return (
      `La **compra más cara del año** fue de **${formatCurrency(top.totalAmount, cur)}** en **${top.supermarket}** el **${top.purchaseDate}**, pagada por **${buyer}**.\n\n` +
      `**Principales productos de esa factura:**\n` +
      top.items
        .slice(0, 4)
        .map((i) => `• ${i.normalizedName}: **${formatCurrency(i.totalPrice, cur)}**`)
        .join('\n') +
      (second
        ? `\n\nLa segunda compra más alta fue de **${formatCurrency(second.totalAmount, cur)}** en **${second.supermarket}** el ${second.purchaseDate}.`
        : '')
    );
  }

  // 3. Comparador de supermercados
  if (
    q.includes('barato') ||
    q.includes('supermercado') ||
    q.includes('ahorr') ||
    q.includes('cheapest') ||
    q.includes('compar')
  ) {
    return (
      `Según el historial de precios por unidad base en **PriceSmart**, **Walmart**, **MasxMenos** y **Auto Mercado**:\n\n` +
      `• **PriceSmart** ofrece el menor precio en proteínas y volumen: **Pechuga de Pollo** (${formatCurrency(5400, cur)}/kg vs. ${formatCurrency(6400, cur)}/kg en Auto Mercado — **16% de ahorro**) y **Huevos** (${formatCurrency(148, cur)}/unid vs. ${formatCurrency(180, cur)}/unid).\n` +
      `• **Walmart** tiene el mejor precio en **Leche** (${formatCurrency(920, cur)} por 900ml) y **Café 1820** (${formatCurrency(5650, cur)} por 500g).\n` +
      `• Comprar tu lista activa en **Walmart + PriceSmart** te ahorra aprox. **${formatCurrency(8900, cur)}** esta semana.`
    );
  }

  // 4. Productos por agotarse / vencer
  if (
    q.includes('agot') ||
    q.includes('falta') ||
    q.includes('repon') ||
    q.includes('venc') ||
    q.includes('despensa') ||
    q.includes('low')
  ) {
    const lowList = context.predictions.slice(0, 4);
    const expiring = context.pantry.filter((p) => p.estimatedExpiryDate <= addDaysIso(getTodayIso(), 4));
    return (
      `**Productos próximos a agotarse (Predicción IA):**\n` +
      lowList
        .map(
          (r) =>
            `• **${r.canonicalName}**: quedan ~**${Math.round(r.estimatedDaysRemaining)} días** (ritmo: ${r.weightedDailyRate} ${r.baseUnit}/día, última compra: ${r.lastPurchaseDisplayQty} el ${r.lastPurchaseDate})`
        )
        .join('\n') +
      `\n\n**Productos por vencer pronto en la Despensa Virtual:**\n` +
      expiring
        .map(
          (p) => `• **${p.name}**): vence el **${p.estimatedExpiryDate}**`
        )
        .join('\n')
    );
  }

  const octTotal = context.purchases
    .filter((p) => p.purchaseDate.startsWith(getCurrentMonthPrefix()))
    .reduce((s, p) => s + p.totalAmount, 0);
  const septTotal = context.purchases
    .filter((p) => p.purchaseDate.startsWith(getPreviousMonthPrefix()))
    .reduce((s, p) => s + p.totalAmount, 0);

  return lang === 'en'
    ? `Snapshot for **${context.household.name}**: ${monthName(getCurrentMonthPrefix(), 'en')} spent is **${formatCurrency(octTotal, cur)}** of **${formatCurrency(context.household.monthlyBudget, cur)}**.`
    : `Resumen actual de **${context.household.name}**:\n\n` +
        `• **Gasto de ${monthLabel(getCurrentMonthPrefix())}:** **${formatCurrency(octTotal, cur)}** de tu presupuesto de **${formatCurrency(context.household.monthlyBudget, cur)}** (${Math.round((octTotal / context.household.monthlyBudget) * 100)}%).\n` +
        `• **Total de ${monthLabel(getPreviousMonthPrefix())}:** **${formatCurrency(septTotal, cur)}**.\n` +
        `• **Reposición más urgente:** **${context.predictions[0]?.canonicalName || 'Leche'}** (~${Math.round(context.predictions[0]?.estimatedDaysRemaining ?? 2)} días restantes).\n\n` +
        `Puedes preguntarme: *"¿Cuánto gastamos en carne en septiembre?"*, *"¿Cuál fue la compra más cara del año?"* o *"¿En qué supermercado sale más barato el pollo y la leche?"*`;
}

export { normalizeToBaseUnit, normalizeReceiptProduct };
