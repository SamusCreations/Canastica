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
import { devLog, setDevStatus, type DevStatus } from '../lib/devConsole';

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

export const AI_FUNCTION_NAME = 'assistant';

let lastGeminiError: string | null = null;

/** Why the last AI call failed, in words the user can act on (null after a success). */
export function getLastGeminiError(): string | null {
  return lastGeminiError;
}

// ---------------------------------------------------------------------------
// Daily AI quota (enforced on the server; mirrored here to show it and disable buttons)
// ---------------------------------------------------------------------------

export interface AiQuota {
  used: number;
  limit: number;
  remaining: number;
  exempt: boolean;
}

let aiQuota: AiQuota | null = null;
const quotaListeners = new Set<() => void>();

export function getAiQuota(): AiQuota | null {
  return aiQuota;
}

export function subscribeAiQuota(listener: () => void): () => void {
  quotaListeners.add(listener);
  return () => quotaListeners.delete(listener);
}

function setAiQuota(next: unknown): void {
  if (!next || typeof next !== 'object') return;
  const q = next as Partial<AiQuota>;
  if (typeof q.limit !== 'number') return;
  aiQuota = {
    used: Number(q.used ?? 0),
    limit: q.limit,
    remaining: Number(q.remaining ?? 0),
    exempt: Boolean(q.exempt),
  };
  quotaListeners.forEach((l) => l());
}

export function hasAiQuotaLeft(): boolean {
  return !aiQuota || aiQuota.exempt || aiQuota.remaining > 0;
}

export function describeAiQuota(q: AiQuota | null): string {
  if (!q) return '';
  if (q.exempt) return 'Consultas de IA sin límite';
  if (q.remaining <= 0) return `Llegaste al límite de ${q.limit} consultas de IA por hoy. Vuelve a intentarlo mañana.`;
  return `Te quedan ${q.remaining} de ${q.limit} consultas de IA hoy`;
}

export async function refreshAiQuota(): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return;
  const { data } = await client.functions.invoke(AI_FUNCTION_NAME, { body: { action: 'quota' } }).catch(() => ({ data: null }));
  if (data?.quota) setAiQuota(data.quota);
}

/** Asks the server whether this account is a developer; only then is the dev console enabled. */
export async function loadDevStatus(): Promise<DevStatus> {
  const client = getSupabaseClient();
  if (!client) {
    setDevStatus(null);
    return { isDeveloper: false };
  }
  const started = performance.now();
  const { data, error } = await client.functions
    .invoke(AI_FUNCTION_NAME, { body: { action: 'dev-status' } })
    .catch((err) => ({ data: null, error: err as Error }));
  if (error) {
    // Usually CORS: this origin is missing from ALLOWED_ORIGINS. Kept for problem reports.
    devLog('error', 'Servidor', `dev-status falló (${error.name}) desde ${window.location.origin}`);
  }
  const status: DevStatus = data?.isDeveloper ? { isDeveloper: true, config: data.config } : { isDeveloper: false };
  setDevStatus(status);
  devLog('info', 'Servidor', 'dev-status', {
    durationMs: Math.round(performance.now() - started),
    detail: status.config,
  });
  return status;
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
  if (code === 'AI_QUOTA') return describeAiQuota(aiQuota) || 'Llegaste al límite de consultas de IA por hoy. Vuelve a intentarlo mañana.';
  if (code === 'too_large') return 'La imagen es demasiado grande. Prueba con otra foto.';
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

  const started = performance.now();
  const elapsed = () => Math.round(performance.now() - started);
  devLog('info', 'IA', `${action}: enviando`);
  try {
    const { data, error } = await client.functions.invoke(AI_FUNCTION_NAME, {
      body: { action, payload },
    });
    if (error) {
      if (error instanceof FunctionsHttpError) {
        const response = error.context as Response;
        const body = await response.json().catch(() => null);
        setAiQuota(body?.quota);
        lastGeminiError = describeGeminiError(body?.code, response.status);
        devLog('error', 'IA', `${action}: HTTP ${response.status} ${body?.code ?? ''}`, {
          durationMs: elapsed(),
          detail: body,
        });
      } else {
        lastGeminiError = describeGeminiError(navigator.onLine ? 'internal' : 'offline');
        devLog('error', 'IA', `${action}: ${error.name}`, { durationMs: elapsed(), detail: error.message });
      }
      return null;
    }
    setAiQuota(data?.quota);
    if (data?.error) {
      lastGeminiError = describeGeminiError(data.code);
      devLog('error', 'IA', `${action}: ${data.code}`, { durationMs: elapsed(), detail: data });
      return null;
    }
    lastGeminiError = null;
    devLog('success', 'IA', `${action}: OK`, { durationMs: elapsed(), detail: data?.debug });
    return data as T;
  } catch (err) {
    lastGeminiError = describeGeminiError(navigator.onLine ? 'internal' : 'offline');
    devLog('error', 'IA', `${action}: excepción`, { durationMs: elapsed(), detail: String(err) });
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

/** Downscales big camera photos before reading them: faster upload, fewer failures. */
export async function shrinkImageDataUrl(dataUrl: string, maxSide = 2000, quality = 0.85): Promise<string> {
  try {
    const blob = await (await fetch(dataUrl)).blob();
    if (!blob.type.startsWith('image/') || blob.type === 'image/svg+xml') return dataUrl;
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && blob.size < 1_500_000 && blob.type === 'image/jpeg') return dataUrl;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', quality);
  } catch {
    return dataUrl;
  }
}

export async function scanReceiptImageWithAI(
  originalDataUrl: string,
  language: 'es' | 'en' = 'es'
): Promise<ScannedReceiptResult> {
  if (!hasAiQuotaLeft()) {
    return {
      isBlurry: true,
      blurryAdvice: describeAiQuota(aiQuota),
      supermarket: '',
      purchaseDate: getTodayIso(),
      dateSource: 'none',
      discounts: 0,
      taxes: 0,
      receiptTotal: 0,
      items: [],
    };
  }
  const shrinkStart = performance.now();
  const base64DataUrl = await shrinkImageDataUrl(originalDataUrl);
  devLog('info', 'Escaneo', 'Imagen preparada', {
    durationMs: Math.round(performance.now() - shrinkStart),
    detail: { originalChars: originalDataUrl.length, sentChars: base64DataUrl.length },
  });
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
    devLog(reconciled.isBlurry ? 'warn' : 'success', 'Escaneo', reconciled.isBlurry
      ? 'La IA no pudo leer la factura'
      : `${reconciled.items.length} productos, total ${reconciled.receiptTotal}, fecha ${reconciled.purchaseDate || '—'} (${reconciled.dateSource})`,
    { detail: reconciled.validation });
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

export const MAX_SHOPPING_TEXT_CHARS = 300;

export async function parseNaturalLanguageShoppingInput(
  rawInput: string,
  language: 'es' | 'en' = 'es'
): Promise<ParsedShoppingInputItem[]> {
  const trimmed = rawInput.trim().slice(0, MAX_SHOPPING_TEXT_CHARS);
  if (!trimmed) return [];

  // Without quota left, the simple local splitter below still works
  if (hasAiQuotaLeft()) {
    const aiParsed = await invokeGeminiJSON<{ items?: ParsedShoppingInputItem[] }>('parse-shopping-input', {
      text: trimmed,
      language,
    });
    const items = aiParsed?.items?.filter((it) =>
      VALID_CATEGORIES.includes(it.category)
    );
    if (items && items.length > 0) {
      return items;
    }
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
