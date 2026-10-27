// ============================================================================
// Canastica: shared receipt extraction contract
// Used by BOTH the assistant Edge Function (Deno) and the web app (Vite), so it
// must stay dependency free. It holds:
// - the Gemini prompt + responseSchema for "scan-receipt"
// - reconcileReceipt(): deterministic clean-up of what the model returned
//   (CR number formats, promo lines folded into their item, weighed items,
//   IVA included vs. added, sum check against the printed total)
// - buildRepairPrompt(): second pass when the sum does not match the total
// ============================================================================

export type ReceiptBaseUnit = 'ml' | 'g' | 'units';
export type PricingMode = 'unit' | 'multi' | 'weight';

export interface ExtractedReceiptItem {
  rawReceiptName: string;
  sourceLines?: string[];
  barcode?: string | null;
  normalizedName: string;
  canonicalName: string;
  category: string;
  pricingMode?: PricingMode;
  quantity: number;
  unit: string;
  sizeKnown?: boolean;
  baseUnitQuantity: number;
  baseUnit: ReceiptBaseUnit;
  unitPrice: number;
  grossPrice?: number;
  discount?: number;
  discountLabel?: string | null;
  totalPrice: number;
  taxCode?: string | null;
  nameConfidence?: 'high' | 'medium' | 'low';
  estimatedShelfLifeDays?: number;
  storageLocation?: string;
  needsReview?: boolean;
  reviewReasons?: string[];
}

export interface ReceiptValidation {
  itemsNetSum: number;
  expectedTotal: number;
  difference: number;
  isBalanced: boolean;
  printedItemCount: number | null;
  countedItems: number;
  itemCountMatches: boolean | null;
  warnings: string[];
  repaired?: boolean;
}

export type ReceiptDateSource = 'printed' | 'clave' | 'none';

export interface ExtractedReceipt {
  isBlurry: boolean;
  blurryAdvice?: string | null;
  supermarket: string;
  purchaseDate: string;
  /** true only when the date is literally printed on the receipt */
  datePrinted?: boolean | null;
  /** where purchaseDate came from; 'none' means the user must confirm it */
  dateSource?: ReceiptDateSource;
  currency?: string;
  pricesIncludeTax?: boolean | null;
  subtotal?: number | null;
  discounts: number; // receipt-level discounts only (NOT the per-item promos)
  taxes: number;
  receiptTotal: number;
  printedItemCount?: number | null;
  claveNumerica?: string | null;
  items: ExtractedReceiptItem[];
  validation?: ReceiptValidation;
}

const CATEGORIES =
  'Dairy & Eggs | Meat & Poultry | Produce | Bakery | Pantry Staples | Beverages | Snacks | Cleaning & Home | Personal Care';

export function buildScanReceiptPrompt(language: 'es' | 'en' = 'es'): string {
  const nameLang = language === 'en' ? 'English' : 'Spanish (Costa Rica)';
  return `You are the receipt reader of Canastica, a grocery app for households in Costa Rica.
Read the supermarket receipt in the image and return JSON that follows the response schema exactly.

STEP 0: If the image is too blurry, dark, cut off or unreadable to extract the items reliably, return
{ "isBlurry": true, "blurryAdvice": "<short friendly tip in ${nameLang} on how to retake the photo>", "items": [] } and stop.

STEP 1: Read the item block line by line, top to bottom. Every product is a group of 1 to 3 printed lines.
Put the exact printed lines of the group in "sourceLines". Common layouts (Pali, Maxi Palí, Walmart, Masxmenos, Más x Menos, Auto Mercado, Fresh Market, Megasuper, PriceSmart, pulperías):
  a) One line: DESCRIPTION  BARCODE  PRICE  TAXCODE
       "LECHE DOS P 744100160100   2,730 G" -> quantity 1, unitPrice 2730, grossPrice 2730, pricingMode "unit"
  b) Weighed: description + store code ending in K (often starts with 2), then a weight line
       "BISTEC POPI 2616474061812K" / "1.020Kg A 6,060/Kg   6,181 G"
       -> pricingMode "weight", quantity 1.02, unit "kg", unitPrice 6060 (price per kg), grossPrice 6181,
          baseUnit "g", baseUnitQuantity 1020
  c) Multiple units: description + barcode, then "N X ₡PRICE   LINE_TOTAL"
       "BEBIDA LIF 744104260603" / "14 X ₡170   2,380 G" -> pricingMode "multi", quantity 14, unitPrice 170, grossPrice 2380
  d) Discount line right after a product: "PROMO AC06  -480", "DESCUENTO", "DCTO", "AHORRO", "REBAJA", "2x1", "OFERTA"
       -> NOT a separate item. Put it on the product above it: discount 480 (positive number), discountLabel "PROMO AC06".
  A line with only a quantity, weight or discount always belongs to the product printed just above it.
  Never invent items. Do not include Subtotal, Total, payment lines (TARJETAS, EFECTIVO, VUELTO), the IVA table, or bag/footer lines as items.

STEP 2: Numbers. Colones (₡, CRC, sometimes printed as "C" or "¢"). On these receipts a comma is a thousands separator
("14,487" = 14487, "6,060" = 6060) and a dot is a decimal separator in weights ("1.020Kg" = 1.02 kg, "0.890Kg" = 0.89 kg).
If a receipt uses "2.730,00" style, the last separator is the decimal one. Return plain JSON numbers, never strings.
For every item: grossPrice = printed line amount BEFORE the discount, discount >= 0, totalPrice = grossPrice - discount.
Check quantity x unitPrice ~= grossPrice (weighed items round to the nearest colón).

STEP 3: Names. Receipts abbreviate and cut names to ~12 characters. Use what you know about Costa Rican products and brands
to expand them, without inventing facts:
  "LECHE DOS P" -> "Leche Dos Pinos", "SULI AZUCAR" -> "Azúcar Sulí", "CEBOLLA KG" -> "Cebolla", "SALSA CARNE" -> "Salsa para Carne".
  - rawReceiptName: ONLY the printed description text, exactly as printed, without barcode, quantity or price (e.g. "LECHE DOS P").
  - barcode: the printed product code (digits, keep a trailing K if printed), or null.
  - normalizedName: clean readable name in ${nameLang}: product + brand + presentation ONLY if printed or certain.
  - canonicalName: generic product group in ${nameLang}, no brand and no size (e.g. "Leche", "Azúcar", "Bistec de Res", "Cebolla", "Bebida", "Salsa").
  - nameConfidence: "high" if the expansion is certain, "medium" if likely, "low" if you are guessing.
  - category: one of ${CATEGORIES}.

STEP 4: Units. Many receipts do NOT print the package size.
  - Size printed (e.g. "1L", "900ML", "2KG", "6U"): sizeKnown true; unit is the presentation (e.g. "L", "900ml", "kg") and
    baseUnitQuantity is the total in ml / g / units for the whole line (2 x 1L -> 2000 ml).
  - Weighed item: unit "kg", baseUnit "g", baseUnitQuantity = weight in grams, sizeKnown true.
  - Size NOT printed: sizeKnown false, unit "unid", baseUnit "units", baseUnitQuantity = quantity. Do NOT guess a size.

STEP 5: Header and totals.
  - supermarket: commercial store name as printed at the top (e.g. "Pali Sarchí" -> "Palí"), not the legal company name.
  - purchaseDate: YYYY-MM-DD, ONLY if a purchase date is literally printed on the receipt (e.g. "FECHA 24/10/2026").
    Never guess or infer it. If no date is printed, use null.
  - datePrinted: true only when purchaseDate was read from a date printed on the receipt, else false.
  - receiptTotal: the printed TOTAL. subtotal: the printed Subtotal or null.
  - discounts: ONLY discounts printed at receipt level that are not attached to an item (else 0).
  - taxes: total IVA printed in the tax summary (sum of the IVA column, e.g. 111 + 377 = 488), else 0.
  - pricesIncludeTax: true when item prices already include IVA (in Costa Rica this is the norm: items - discounts = total
    and the IVA table is only informative). false only when IVA is added on top of the subtotal.
  - printedItemCount: the "# ARTS. VENDIDOS" / "ARTICULOS" count if printed, else null.
  - claveNumerica: the 50-digit "Clave Numérica" of the electronic receipt (digits only), or null.
  - taxCode: the letter/code printed after the item price (e.g. "G", "E", "*"), or null.
Final check before answering: sum(totalPrice) - discounts (+ taxes only if pricesIncludeTax is false) must equal receiptTotal.
If it does not, re-read the item block: a missed line, a discount not applied, or a misread digit is the usual cause.`;
}

// Gemini structured output schema (OpenAPI subset).
export const SCAN_RECEIPT_RESPONSE_SCHEMA = {
  type: 'OBJECT',
  properties: {
    isBlurry: { type: 'BOOLEAN' },
    blurryAdvice: { type: 'STRING', nullable: true },
    supermarket: { type: 'STRING' },
    purchaseDate: { type: 'STRING', nullable: true },
    datePrinted: { type: 'BOOLEAN', nullable: true },
    currency: { type: 'STRING', enum: ['CRC', 'USD'] },
    pricesIncludeTax: { type: 'BOOLEAN', nullable: true },
    subtotal: { type: 'NUMBER', nullable: true },
    discounts: { type: 'NUMBER' },
    taxes: { type: 'NUMBER' },
    receiptTotal: { type: 'NUMBER' },
    printedItemCount: { type: 'INTEGER', nullable: true },
    claveNumerica: { type: 'STRING', nullable: true },
    items: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          sourceLines: { type: 'ARRAY', items: { type: 'STRING' } },
          rawReceiptName: { type: 'STRING' },
          barcode: { type: 'STRING', nullable: true },
          normalizedName: { type: 'STRING' },
          canonicalName: { type: 'STRING' },
          nameConfidence: { type: 'STRING', enum: ['high', 'medium', 'low'] },
          category: {
            type: 'STRING',
            enum: [
              'Dairy & Eggs',
              'Meat & Poultry',
              'Produce',
              'Bakery',
              'Pantry Staples',
              'Beverages',
              'Snacks',
              'Cleaning & Home',
              'Personal Care',
            ],
          },
          pricingMode: { type: 'STRING', enum: ['unit', 'multi', 'weight'] },
          quantity: { type: 'NUMBER' },
          unit: { type: 'STRING' },
          sizeKnown: { type: 'BOOLEAN' },
          baseUnitQuantity: { type: 'NUMBER' },
          baseUnit: { type: 'STRING', enum: ['ml', 'g', 'units'] },
          unitPrice: { type: 'NUMBER' },
          grossPrice: { type: 'NUMBER' },
          discount: { type: 'NUMBER' },
          discountLabel: { type: 'STRING', nullable: true },
          totalPrice: { type: 'NUMBER' },
          taxCode: { type: 'STRING', nullable: true },
          estimatedShelfLifeDays: { type: 'INTEGER' },
          storageLocation: { type: 'STRING', enum: ['Fridge', 'Freezer', 'Dry Pantry', 'Household'] },
        },
        required: [
          'sourceLines',
          'rawReceiptName',
          'normalizedName',
          'canonicalName',
          'category',
          'pricingMode',
          'quantity',
          'unit',
          'baseUnitQuantity',
          'baseUnit',
          'unitPrice',
          'grossPrice',
          'discount',
          'totalPrice',
        ],
        propertyOrdering: [
          'sourceLines',
          'rawReceiptName',
          'barcode',
          'normalizedName',
          'canonicalName',
          'nameConfidence',
          'category',
          'pricingMode',
          'quantity',
          'unit',
          'sizeKnown',
          'baseUnitQuantity',
          'baseUnit',
          'unitPrice',
          'grossPrice',
          'discount',
          'discountLabel',
          'totalPrice',
          'taxCode',
          'estimatedShelfLifeDays',
          'storageLocation',
        ],
      },
    },
  },
  required: ['isBlurry', 'items'],
  propertyOrdering: [
    'isBlurry',
    'blurryAdvice',
    'supermarket',
    'purchaseDate',
    'datePrinted',
    'currency',
    'items',
    'subtotal',
    'discounts',
    'taxes',
    'pricesIncludeTax',
    'receiptTotal',
    'printedItemCount',
    'claveNumerica',
  ],
} as const;

// ---------------------------------------------------------------------------
// Number parsing (Costa Rican receipts mix "14,487", "1.020Kg" and "2.730,00")
// ---------------------------------------------------------------------------

export function parseReceiptNumber(value: unknown, kind: 'money' | 'quantity' = 'money'): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value !== 'string') return 0;
  let s = value.replace(/[₡¢$\s]|CRC|kg|KG|Kg/g, '').trim();
  const negative = /^-|-$/.test(s);
  s = s.replace(/-/g, '');
  if (!s) return 0;
  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  if (lastComma >= 0 && lastDot >= 0) {
    // Both present: the last one is the decimal separator
    const decimalSep = lastComma > lastDot ? ',' : '.';
    const thousandsSep = decimalSep === ',' ? '.' : ',';
    s = s.split(thousandsSep).join('').replace(decimalSep, '.');
  } else if (lastComma >= 0) {
    // "14,487" -> thousands; "1,5" -> decimal
    s = /,\d{3}$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  } else if (lastDot >= 0 && kind === 'money' && /^\d{1,3}(\.\d{3})+$/.test(s)) {
    // "2.730" as money -> thousands (weights like "1.020" stay decimal)
    s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  return negative ? -n : n;
}

const PROMO_NAME_RX = /^(promo|desc|dcto|descuento|ahorro|rebaja|oferta|cupon|cupón|2x1|3x2)\b/i;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function cleanBarcode(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const s = value.replace(/\s/g, '').toUpperCase();
  return /^\d{4,14}K?$/.test(s) ? s : null;
}

// ---------------------------------------------------------------------------
// Deterministic reconciliation
// ---------------------------------------------------------------------------

export function reconcileReceipt(input: Partial<ExtractedReceipt> | null | undefined): ExtractedReceipt {
  const src = input ?? {};
  const warnings: string[] = [];

  const rawItems = Array.isArray(src.items) ? src.items : [];
  const items: ExtractedReceiptItem[] = [];

  for (const raw of rawItems) {
    if (!raw || typeof raw !== 'object') continue;
    const rawName = String(raw.rawReceiptName ?? raw.normalizedName ?? '').trim();
    let gross = parseReceiptNumber(raw.grossPrice ?? raw.totalPrice);
    const statedTotal = parseReceiptNumber(raw.totalPrice);
    let discount = Math.abs(parseReceiptNumber(raw.discount));

    // A promo/discount line the model returned as its own item -> fold into the previous product
    const looksLikePromo = PROMO_NAME_RX.test(rawName) || (gross < 0 && statedTotal <= 0);
    if (looksLikePromo && items.length > 0) {
      const prev = items[items.length - 1];
      const amount = Math.abs(gross || statedTotal);
      prev.discount = round2((prev.discount ?? 0) + amount);
      prev.discountLabel = prev.discountLabel || rawName;
      prev.totalPrice = round2((prev.grossPrice ?? prev.totalPrice) - prev.discount);
      prev.sourceLines = [...(prev.sourceLines ?? []), ...(raw.sourceLines ?? [rawName])];
      continue;
    }

    let quantity = parseReceiptNumber(raw.quantity, 'quantity');
    let unitPrice = parseReceiptNumber(raw.unitPrice);
    const reviewReasons: string[] = [];

    // Model sometimes returns gross = net and puts the discount aside
    if (!raw.grossPrice && discount > 0 && statedTotal > 0) gross = statedTotal + discount;
    if (gross <= 0 && quantity > 0 && unitPrice > 0) gross = Math.round(quantity * unitPrice);
    if (quantity <= 0) quantity = unitPrice > 0 && gross > 0 ? round2(gross / unitPrice) : 1;
    if (unitPrice <= 0 && gross > 0) unitPrice = round2(gross / quantity);

    const pricingMode: PricingMode =
      raw.pricingMode === 'weight' || raw.pricingMode === 'multi' || raw.pricingMode === 'unit'
        ? raw.pricingMode
        : /kg/i.test(String(raw.unit ?? '')) && !Number.isInteger(quantity)
          ? 'weight'
          : quantity > 1
            ? 'multi'
            : 'unit';

    const expectedGross = quantity * unitPrice;
    const tolerance = Math.max(2, gross * 0.01);
    if (gross > 0 && Math.abs(expectedGross - gross) > tolerance) {
      reviewReasons.push(
        `Cantidad × precio (${round2(expectedGross)}) no coincide con el monto de la línea (${gross}).`
      );
    }

    if (discount > gross && gross > 0) {
      reviewReasons.push('El descuento es mayor que el precio de la línea.');
      discount = 0;
    }
    const totalPrice = round2(gross - discount);

    // Units: weighed items in grams, unknown sizes as plain units
    let unit = String(raw.unit ?? '').trim() || 'unid';
    let baseUnit: ReceiptBaseUnit =
      raw.baseUnit === 'ml' || raw.baseUnit === 'g' || raw.baseUnit === 'units' ? raw.baseUnit : 'units';
    let baseUnitQuantity = parseReceiptNumber(raw.baseUnitQuantity, 'quantity');
    let sizeKnown = raw.sizeKnown ?? baseUnit !== 'units';
    if (pricingMode === 'weight') {
      unit = 'kg';
      baseUnit = 'g';
      baseUnitQuantity = Math.round(quantity * 1000);
      sizeKnown = true;
    } else if (!sizeKnown) {
      unit = 'unid';
      baseUnit = 'units';
      baseUnitQuantity = quantity;
    } else if (baseUnitQuantity <= 0) {
      baseUnit = 'units';
      baseUnitQuantity = quantity;
    }
    if (!sizeKnown) reviewReasons.push('La factura no indica la presentación (tamaño); revisa la unidad.');

    const nameConfidence = raw.nameConfidence ?? 'medium';
    if (nameConfidence === 'low') reviewReasons.push('Nombre abreviado poco claro; confirma el producto.');

    items.push({
      ...raw,
      rawReceiptName: rawName || 'PRODUCTO',
      barcode: cleanBarcode(raw.barcode),
      normalizedName: String(raw.normalizedName ?? rawName).trim() || rawName,
      canonicalName: String(raw.canonicalName ?? raw.normalizedName ?? rawName).trim(),
      category: String(raw.category ?? 'Pantry Staples'),
      pricingMode,
      quantity: round2(quantity),
      unit,
      sizeKnown,
      baseUnit,
      baseUnitQuantity: round2(baseUnitQuantity),
      unitPrice: round2(unitPrice),
      grossPrice: round2(gross),
      discount: round2(discount),
      discountLabel: discount > 0 ? (raw.discountLabel ?? 'Descuento') : null,
      totalPrice,
      nameConfidence,
      needsReview: reviewReasons.some((r) => !r.startsWith('La factura no indica')) || nameConfidence === 'low',
      reviewReasons,
    });
  }

  const receiptTotal = parseReceiptNumber(src.receiptTotal);
  const receiptDiscounts = Math.abs(parseReceiptNumber(src.discounts));
  const taxes = Math.abs(parseReceiptNumber(src.taxes));
  const itemsNetSum = round2(items.reduce((s, it) => s + it.totalPrice, 0));
  const tolerance = Math.max(2, receiptTotal * 0.002);

  // Decide whether IVA is already inside item prices (the norm in Costa Rica)
  let pricesIncludeTax = typeof src.pricesIncludeTax === 'boolean' ? src.pricesIncludeTax : null;
  const fitsIncluded = Math.abs(itemsNetSum - receiptDiscounts - receiptTotal) <= tolerance;
  const fitsAdded = Math.abs(itemsNetSum - receiptDiscounts + taxes - receiptTotal) <= tolerance;
  if (fitsIncluded && !fitsAdded) pricesIncludeTax = true;
  else if (fitsAdded && !fitsIncluded) pricesIncludeTax = false;
  else if (pricesIncludeTax === null) pricesIncludeTax = true;

  const expectedTotal = round2(itemsNetSum - receiptDiscounts + (pricesIncludeTax ? 0 : taxes));
  const difference = round2(expectedTotal - receiptTotal);
  const isBalanced = receiptTotal > 0 && Math.abs(difference) <= tolerance;
  if (!isBalanced && receiptTotal > 0) {
    warnings.push(
      `La suma de los productos (${expectedTotal}) no coincide con el total impreso (${receiptTotal}).`
    );
  }

  // "# ARTS. VENDIDOS": weighed items count as 1 article, multi lines as N
  const printedItemCount =
    src.printedItemCount === null || src.printedItemCount === undefined
      ? null
      : Math.round(parseReceiptNumber(src.printedItemCount, 'quantity')) || null;
  const countedItems = items.reduce(
    (s, it) => s + (it.pricingMode === 'weight' ? 1 : Math.max(1, Math.round(it.quantity))),
    0
  );
  const itemCountMatches = printedItemCount === null ? null : printedItemCount === countedItems;
  if (itemCountMatches === false) {
    warnings.push(
      `La factura dice ${printedItemCount} artículos y se leyeron ${countedItems}; puede faltar o sobrar un producto.`
    );
  }

  const clave = typeof src.claveNumerica === 'string' ? src.claveNumerica.replace(/\D/g, '') : '';
  // Printed date > date encoded in the Clave Numérica > none (the user confirms it). Never a guessed date.
  const printedDate =
    src.datePrinted === true && typeof src.purchaseDate === 'string' ? plausibleDate(src.purchaseDate) : '';
  const claveDate = plausibleDate(dateFromClaveNumerica(clave));
  const dateSource: ReceiptDateSource = printedDate ? 'printed' : claveDate ? 'clave' : 'none';
  const purchaseDate = printedDate || claveDate;

  return {
    isBlurry: Boolean(src.isBlurry),
    blurryAdvice: src.blurryAdvice ?? null,
    supermarket: String(src.supermarket ?? '').trim(),
    purchaseDate,
    datePrinted: dateSource === 'printed',
    dateSource,
    currency: src.currency ?? 'CRC',
    pricesIncludeTax,
    subtotal: src.subtotal === null || src.subtotal === undefined ? null : parseReceiptNumber(src.subtotal),
    discounts: round2(receiptDiscounts),
    taxes: round2(taxes),
    receiptTotal: round2(receiptTotal),
    printedItemCount,
    claveNumerica: clave || null,
    items,
    validation: {
      itemsNetSum,
      expectedTotal,
      difference,
      isBalanced,
      printedItemCount,
      countedItems,
      itemCountMatches,
      warnings,
      repaired: src.validation?.repaired,
    },
  };
}

/** A real calendar date that is not in the future and not older than a year ('' otherwise). */
function plausibleDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return '';
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (date.getUTCDate() !== Number(m[3]) || date.getUTCMonth() !== Number(m[2]) - 1) return '';
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;
  if (date.getTime() > now + dayMs) return '';
  if (date.getTime() < now - 366 * dayMs) return '';
  return iso;
}

/**
 * Hacienda's 50-digit key: 506 + DDMMYY + ... -> YYYY-MM-DD ('' if it does not look valid).
 * The key often wraps over two printed lines, so a few missing trailing digits are tolerated.
 */
export function dateFromClaveNumerica(clave: string): string {
  if (!/^506\d{37,47}$/.test(clave)) return '';
  const dd = clave.slice(3, 5);
  const mm = clave.slice(5, 7);
  const yy = clave.slice(7, 9);
  const day = Number(dd);
  const month = Number(mm);
  if (day < 1 || day > 31 || month < 1 || month > 12) return '';
  return `20${yy}-${mm}-${dd}`;
}

/** Higher is worse. Used to choose between the first pass and the repair pass. */
export function receiptErrorScore(r: ExtractedReceipt): number {
  const v = r.validation;
  if (!v) return Number.POSITIVE_INFINITY;
  return Math.abs(v.difference) + (v.itemCountMatches === false ? 1 : 0);
}

export function needsRepairPass(r: ExtractedReceipt): boolean {
  if (r.isBlurry || !r.validation) return false;
  return !r.validation.isBalanced || r.validation.itemCountMatches === false;
}

export function buildRepairPrompt(language: 'es' | 'en', previous: ExtractedReceipt): string {
  const v = previous.validation!;
  const issues = [...v.warnings];
  const compact = {
    receiptTotal: previous.receiptTotal,
    discounts: previous.discounts,
    taxes: previous.taxes,
    pricesIncludeTax: previous.pricesIncludeTax,
    printedItemCount: previous.printedItemCount,
    items: previous.items.map((it) => ({
      sourceLines: it.sourceLines,
      rawReceiptName: it.rawReceiptName,
      quantity: it.quantity,
      unitPrice: it.unitPrice,
      grossPrice: it.grossPrice,
      discount: it.discount,
      totalPrice: it.totalPrice,
    })),
  };
  return `${buildScanReceiptPrompt(language)}

A previous reading of this same receipt has an error that you must fix:
${issues.map((i) => `- ${i}`).join('\n')}
Previous reading (numbers only): ${JSON.stringify(compact)}
Read the image again carefully, line by line. Look for: an item that was skipped, a discount line not applied to its item,
a weight or "N X price" line misread, a digit misread (3/8, 1/7, 0/6), or a thousands separator read as a decimal.
Return the full corrected JSON for the whole receipt.`;
}
