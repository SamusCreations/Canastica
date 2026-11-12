// ============================================================================
// "Facturas por correo": the household mailbox and the invoices it received.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { Purchase, PurchaseItem, SupermarketStore } from '../types/grocery';
import type { ScannedReceiptResult } from './geminiAndSupabaseService';
import { parseElectronicInvoiceXml } from '../lib/electronicInvoice';
import { normalizeReceiptProduct } from '../lib/restockEngine';

const BUCKET = 'inbound-invoices';
export const INBOUND_DOMAIN = ((import.meta.env.VITE_INBOUND_DOMAIN as string | undefined) ?? '').trim();

export interface InvoiceMailbox {
  householdId: string;
  code: string;
  /** Readable name (alias@domain); null until the household picks one */
  alias: string | null;
  isActive: boolean;
  autoImport: boolean;
}

/** Files an e-invoice email should carry; `missing` lists the ones that didn't arrive */
export type InboundPart = 'factura' | 'respuesta' | 'pdf';

export type InboundStatus = 'pending' | 'imported' | 'rejected' | 'duplicate' | 'error' | 'confirmation';

export interface InboundInvoice {
  id: string;
  sender: string;
  subject: string;
  clave: string | null;
  issuer: string | null;
  total: number | null;
  issuedAt: string | null;
  status: InboundStatus;
  errorDetail: string | null;
  confirmationCode: string | null;
  xmlPath: string | null;
  responsePath: string | null;
  pdfPath: string | null;
  /** What Hacienda answered ("aceptado", "rechazado"…), from its response XML */
  haciendaStatus: string | null;
  /** Invoice XML + Hacienda response + PDF all arrived */
  isComplete: boolean;
  missing: InboundPart[];
  receivedAt: string;
}

const PART_LABEL: Record<InboundPart, string> = {
  factura: 'el XML de la factura',
  respuesta: 'la respuesta de Hacienda',
  pdf: 'el PDF',
};

/** "Falta el PDF y la respuesta de Hacienda" */
export function missingText(missing: InboundPart[]): string {
  const parts = missing.map((m) => PART_LABEL[m]);
  if (parts.length === 0) return '';
  const list = parts.length === 1 ? parts[0] : `${parts.slice(0, -1).join(', ')} y ${parts[parts.length - 1]}`;
  return `Falta ${list}`;
}

export const isHaciendaRejected = (inv: InboundInvoice) => Boolean(inv.haciendaStatus && /rechaz/.test(inv.haciendaStatus));

/** Only complete sets that Hacienda accepted are imported without review */
export const canAutoImport = (inv: InboundInvoice) =>
  inv.status === 'pending' && inv.isComplete && Boolean(inv.xmlPath) && !isHaciendaRejected(inv);

/** Code address: works always, but it's hard to dictate */
export function mailboxAddress(code: string): string {
  return `facturas+${code}@${INBOUND_DOMAIN}`;
}

export function aliasAddress(alias: string): string {
  return `${alias}@${INBOUND_DOMAIN}`;
}

/** Same rules as public.normalize_invoice_alias(): "Familia Peña" -> "familia-pena" */
export function normalizeAlias(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[\s_.]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 30)
    .replace(/-+$/g, '');
}

export type AliasCheck = 'ok' | 'invalid' | 'reserved' | 'taken' | 'mine';

export async function checkAlias(sb: SupabaseClient, alias: string, householdId: string): Promise<AliasCheck> {
  const { data, error } = await sb.rpc('check_invoice_alias', { p_alias: alias, p_household_id: householdId });
  if (error) throw new Error(error.message);
  return data as AliasCheck;
}

/** Saves the alias (the previous one keeps working 30 days); returns the stored form */
export async function saveAlias(sb: SupabaseClient, householdId: string, alias: string): Promise<string> {
  const { data, error } = await sb.rpc('set_invoice_alias', { p_household_id: householdId, p_alias: alias });
  if (error) {
    const reason = error.message.match(/alias_(invalid|reserved|taken)/)?.[1];
    throw new Error(reason ?? error.message);
  }
  return data as string;
}

/** First free name built from the household's name: "rodriguez", "rodriguez-2"… */
export async function suggestAlias(sb: SupabaseClient, householdId: string, householdName: string): Promise<string | null> {
  const base = normalizeAlias(householdName.replace(/^(hogar|casa|familia)\s+(de\s+(la\s+|los\s+)?)?/i, '')) || 'mi-hogar';
  const root = base.length >= 3 ? base.slice(0, 27).replace(/-+$/, '') : `${base}-casa`;
  for (const candidate of [root, ...[2, 3, 4, 5, 6].map((n) => `${root}-${n}`)]) {
    try {
      const result = await checkAlias(sb, candidate, householdId);
      if (result === 'ok' || result === 'mine') return candidate;
    } catch {
      return null;
    }
  }
  return null;
}

function randomCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = new Uint8Array(10);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
}

function mapMailbox(r: Record<string, unknown>, alias: string | null): InvoiceMailbox {
  return {
    householdId: r.household_id as string,
    code: r.code as string,
    alias,
    isActive: Boolean(r.is_active),
    autoImport: Boolean(r.auto_import),
  };
}

async function currentAlias(sb: SupabaseClient, householdId: string): Promise<string | null> {
  const { data, error } = await sb
    .from('invoice_mailbox_aliases')
    .select('alias')
    .eq('household_id', householdId)
    .is('expires_at', null)
    .maybeSingle();
  return error || !data ? null : (data.alias as string);
}

/** Null when the household never turned it on (or the migration isn't applied yet). */
export async function getMailbox(sb: SupabaseClient, householdId: string): Promise<InvoiceMailbox | null> {
  const { data, error } = await sb.from('invoice_mailboxes').select('*').eq('household_id', householdId).maybeSingle();
  if (error || !data) return null;
  return mapMailbox(data, await currentAlias(sb, householdId));
}

export async function enableMailbox(sb: SupabaseClient, householdId: string, userId: string): Promise<InvoiceMailbox> {
  const existing = await getMailbox(sb, householdId);
  if (existing) {
    await updateMailbox(sb, householdId, { is_active: true });
    return { ...existing, isActive: true };
  }
  const { data, error } = await sb
    .from('invoice_mailboxes')
    .insert({ household_id: householdId, code: randomCode(), created_by: userId, auto_import: true })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return mapMailbox(data, null);
}

export async function updateMailbox(
  sb: SupabaseClient,
  householdId: string,
  patch: { is_active?: boolean; auto_import?: boolean; code?: string }
): Promise<void> {
  const { error } = await sb
    .from('invoice_mailboxes')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('household_id', householdId);
  if (error) throw new Error(error.message);
}

/** New address; the old one stops working right away (Gmail's filter must be updated). */
export async function regenerateMailboxCode(sb: SupabaseClient, householdId: string): Promise<string> {
  const code = randomCode();
  await updateMailbox(sb, householdId, { code });
  return code;
}

function mapInbound(r: Record<string, unknown>): InboundInvoice {
  return {
    id: r.id as string,
    sender: (r.sender as string) ?? '',
    subject: (r.subject as string) ?? '',
    clave: (r.clave as string | null) ?? null,
    issuer: (r.issuer as string | null) ?? null,
    total: r.total == null ? null : Number(r.total),
    issuedAt: (r.issued_at as string | null) ?? null,
    status: r.status as InboundStatus,
    errorDetail: (r.error_detail as string | null) ?? null,
    confirmationCode: (r.confirmation_code as string | null) ?? null,
    xmlPath: (r.xml_path as string | null) ?? null,
    responsePath: (r.response_path as string | null) ?? null,
    pdfPath: (r.pdf_path as string | null) ?? null,
    haciendaStatus: (r.hacienda_status as string | null) ?? null,
    isComplete: Boolean(r.is_complete),
    missing: Array.isArray(r.missing) ? (r.missing as InboundPart[]) : [],
    receivedAt: r.received_at as string,
  };
}

/** Pending invoices plus recent confirmations / errors (never throws). */
export async function listInboundInvoices(sb: SupabaseClient, householdId: string): Promise<InboundInvoice[]> {
  const recent = Date.now() - 14 * 86_400_000;
  const { data, error } = await sb
    .from('inbound_invoices')
    .select('*')
    .eq('household_id', householdId)
    .in('status', ['pending', 'confirmation', 'error'])
    .gte('received_at', new Date(Date.now() - 180 * 86_400_000).toISOString())
    .order('received_at', { ascending: false })
    .limit(60);
  if (error) return [];
  return (data ?? [])
    .map(mapInbound)
    .filter((i) => i.status === 'pending' || new Date(i.receivedAt).getTime() >= recent);
}

export async function setInboundStatus(
  sb: SupabaseClient,
  id: string,
  status: Extract<InboundStatus, 'imported' | 'rejected'>,
  purchaseId?: string
): Promise<void> {
  const { error } = await sb
    .from('inbound_invoices')
    .update({ status, purchase_id: purchaseId ?? null, processed_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * Takes a pending invoice for automatic import. Only one device wins (the update only
 * matches while it is still pending), so two members online at once don't import it twice.
 */
export async function claimInboundForImport(sb: SupabaseClient, id: string): Promise<boolean> {
  const { data, error } = await sb
    .from('inbound_invoices')
    .update({ status: 'imported', processed_at: new Date().toISOString() })
    .eq('id', id)
    .eq('status', 'pending')
    .select('id');
  return !error && (data?.length ?? 0) > 0;
}

export async function linkInboundPurchase(sb: SupabaseClient, id: string, purchaseId: string): Promise<void> {
  await sb.from('inbound_invoices').update({ purchase_id: purchaseId }).eq('id', id);
}

export async function pdfUrl(sb: SupabaseClient, path: string): Promise<string | null> {
  const { data } = await sb.storage.from(BUCKET).createSignedUrl(path, 600);
  return data?.signedUrl ?? null;
}

/** PDF of the email invoice a purchase was imported from, if it had one */
export async function inboundPdfForPurchase(sb: SupabaseClient, purchaseId: string): Promise<string | null> {
  const { data, error } = await sb
    .from('inbound_invoices')
    .select('pdf_path')
    .eq('purchase_id', purchaseId)
    .not('pdf_path', 'is', null)
    .limit(1)
    .maybeSingle();
  return error || !data ? null : (data.pdf_path as string);
}

/** Downloads and reads the XML in the browser with the same parser as manual uploads. */
export async function loadInboundScan(
  sb: SupabaseClient,
  invoice: InboundInvoice
): Promise<{ dataUrl: string; result: ScannedReceiptResult } | null> {
  if (!invoice.xmlPath) return null;
  const { data, error } = await sb.storage.from(BUCKET).download(invoice.xmlPath);
  if (error || !data) return null;
  const xml = await data.text();
  const result = parseElectronicInvoiceXml(xml);
  if (!result) return null;
  const bytes = new TextEncoder().encode(xml);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return { dataUrl: `data:application/xml;base64,${btoa(binary)}`, result };
}

const fold = (v: string) => v.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** Same conversion the scanner does on "Guardar", for invoices imported automatically. */
export function purchaseFromScan(
  result: ScannedReceiptResult,
  dataUrl: string,
  supermarkets: SupermarketStore[],
  memberId: string
): Purchase {
  const scannedStore = fold(result.supermarket || '');
  const known = scannedStore
    ? supermarkets.find((st) => {
        const name = fold(st.name);
        return name === scannedStore || scannedStore.startsWith(`${name} `) || name.startsWith(`${scannedStore} `);
      })
    : undefined;
  const supermarket = known?.name || result.supermarket || 'Factura electrónica';
  const purchaseDate = result.purchaseDate || new Date().toISOString().slice(0, 10);
  const items: PurchaseItem[] = result.items.map((it, idx) => ({
    id: `pi-${Date.now()}-${idx}`,
    purchaseId: '',
    rawReceiptName: it.rawReceiptName,
    normalizedName: it.normalizedName,
    canonicalName: it.canonicalName || normalizeReceiptProduct(it.normalizedName).canonicalName,
    category: it.category,
    quantity: it.quantity,
    unit: it.unit,
    baseUnitQuantity: it.baseUnitQuantity,
    baseUnit: it.baseUnit,
    unitPrice: it.unitPrice,
    totalPrice: it.totalPrice,
    isShared: true,
    createdBy: memberId,
    purchaseDate,
    supermarket,
  }));
  const itemsTotal = items.reduce((s, i) => s + i.totalPrice, 0);
  const promos = result.items.reduce((s, i) => s + (i.discount || 0), 0);
  return {
    id: '',
    householdId: '',
    supermarket,
    purchaseDate,
    createdBy: memberId,
    subtotal: itemsTotal + promos,
    discounts: promos + (result.discounts || 0),
    taxes: result.taxes || 0,
    totalAmount: result.receiptTotal || itemsTotal,
    notes: 'Importada por correo',
    receiptImageUrl: dataUrl,
    items,
  };
}
