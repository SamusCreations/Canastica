// ============================================================================
// Costa Rica electronic invoices (Hacienda XML v4.3 / v4.4): read without AI.
// FacturaElectronica, TiqueteElectronico, NotaCredito… share the same layout.
// ============================================================================
import { reconcileReceipt, type ExtractedReceiptItem } from '../../supabase/functions/_shared/receiptExtraction.ts';
import { normalizeReceiptProduct, normalizeToBaseUnit } from './restockEngine';
import type { ScannedReceiptResult } from '../services/geminiAndSupabaseService';

/** Data URL or file content looks like an electronic invoice XML. */
export function isElectronicInvoiceFile(file: File): boolean {
  return /\.xml$/i.test(file.name) || /(^|\/)(xml)$/.test(file.type) || file.type === 'text/xml';
}

// Hacienda XML uses a default namespace; match on local names only
function child(parent: Element | Document | null | undefined, name: string): Element | undefined {
  if (!parent) return undefined;
  for (const el of Array.from(parent.children ?? [])) {
    if (el.localName === name) return el;
  }
  return undefined;
}

function path(parent: Element | Document | null | undefined, ...names: string[]): Element | undefined {
  let current: Element | Document | undefined = parent ?? undefined;
  for (const n of names) {
    current = child(current, n);
    if (!current) return undefined;
  }
  return current as Element;
}

function text(parent: Element | Document | null | undefined, ...names: string[]): string {
  return path(parent, ...names)?.textContent?.trim() ?? '';
}

function amount(parent: Element | Document | null | undefined, ...names: string[]): number {
  const value = Number(text(parent, ...names).replace(',', '.'));
  return Number.isFinite(value) ? value : 0;
}

// Hacienda's UnidadMedida codes → the units the app uses
function mapUnit(code: string): { unit: string; pricingMode: 'unit' | 'weight' } {
  const c = code.trim().toLowerCase();
  if (c === 'kg') return { unit: 'kg', pricingMode: 'weight' };
  if (c === 'g') return { unit: 'g', pricingMode: 'weight' };
  if (c === 'l') return { unit: 'L', pricingMode: 'unit' };
  if (c === 'ml') return { unit: 'ml', pricingMode: 'unit' };
  return { unit: 'unid', pricingMode: 'unit' };
}

/**
 * Turns a Hacienda electronic invoice XML into the same result the AI reader returns.
 * Returns null when the text is not an electronic invoice.
 */
export function parseElectronicInvoiceXml(xml: string): ScannedReceiptResult | null {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(xml, 'application/xml');
  } catch {
    return null;
  }
  const root = doc.documentElement;
  if (!root || root.getElementsByTagName('parsererror').length > 0) return null;
  const lines = path(root, 'DetalleServicio');
  if (!lines) return null;

  const issuer = text(root, 'Emisor', 'NombreComercial') || text(root, 'Emisor', 'Nombre');
  const issuedAt = text(root, 'FechaEmision');
  const clave = text(root, 'Clave');
  const currency = text(root, 'ResumenFactura', 'CodigoTipoMoneda', 'CodigoMoneda') || 'CRC';
  const rate = currency !== 'CRC' ? amount(root, 'ResumenFactura', 'CodigoTipoMoneda', 'TipoCambio') || 1 : 1;
  const crc = (v: number) => Math.round(v * rate * 100) / 100;

  const items: ExtractedReceiptItem[] = [];
  for (const line of Array.from(lines.children).filter((el) => el.localName === 'LineaDetalle')) {
    const description = text(line, 'Detalle');
    if (!description) continue;
    const quantity = amount(line, 'Cantidad') || 1;
    const { unit, pricingMode } = mapUnit(text(line, 'UnidadMedida'));
    // Discounts can repeat (v4.4): add them all
    const discount = Array.from(line.children)
      .filter((el) => el.localName === 'Descuento')
      .reduce((sum, d) => sum + amount(d, 'MontoDescuento'), 0);
    const lineTotal = amount(line, 'MontoTotalLinea') || amount(line, 'MontoTotal') - discount;
    const gross = lineTotal + discount;
    const barcode =
      Array.from(line.children)
        .filter((el) => el.localName === 'CodigoComercial')
        .map((el) => text(el, 'Codigo'))
        .find(Boolean) ?? null;

    const norm = normalizeReceiptProduct(description);
    const base = normalizeToBaseUnit(quantity, unit, description);
    items.push({
      rawReceiptName: description,
      barcode,
      normalizedName: norm.normalizedName,
      canonicalName: norm.canonicalName,
      category: norm.category,
      pricingMode,
      quantity,
      unit,
      sizeKnown: unit !== 'unid',
      baseUnitQuantity: base.baseUnitQuantity,
      baseUnit: base.baseUnit,
      unitPrice: crc(quantity > 0 ? lineTotal / quantity : lineTotal),
      grossPrice: crc(gross),
      discount: crc(discount),
      discountLabel: discount > 0 ? text(line, 'Descuento', 'NaturalezaDescuento') || 'Descuento' : null,
      totalPrice: crc(lineTotal),
      estimatedShelfLifeDays: norm.shelfLifeDays,
      storageLocation: norm.storageLocation,
    });
  }
  if (items.length === 0) return null;

  const reconciled = reconcileReceipt({
    isBlurry: false,
    supermarket: issuer,
    purchaseDate: issuedAt.slice(0, 10),
    datePrinted: Boolean(issuedAt),
    dateSource: issuedAt ? 'printed' : 'none',
    currency: 'CRC',
    pricesIncludeTax: true,
    subtotal: items.reduce((s, it) => s + it.totalPrice, 0),
    discounts: 0,
    taxes: crc(amount(root, 'ResumenFactura', 'TotalImpuesto')),
    receiptTotal: crc(amount(root, 'ResumenFactura', 'TotalComprobante')),
    printedItemCount: items.length,
    claveNumerica: clave || null,
    items,
  });

  return {
    ...reconciled,
    blurryAdvice: undefined,
    items: reconciled.items.map((it) => ({
      ...it,
      category: it.category as ScannedReceiptResult['items'][number]['category'],
      isShared: true,
    })),
  };
}
