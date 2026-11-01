// ============================================================================
// Canastica: Supabase Household Repository
// Maps the PostgreSQL schema (snake_case rows) to the app domain types and
// exposes the reads / writes the UI performs against Supabase.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { normalizeReceiptProduct } from '../lib/restockEngine';
import { devLog } from '../lib/devConsole';
import {
  BaseUnit,
  CategoryBudget,
  ExpenseSettlement,
  GroceryCategory,
  Household,
  HouseholdMember,
  HouseholdNotification,
  PantryItem,
  Purchase,
  PurchaseItem,
  RestockPrediction,
  ShoppingListItem,
  StorageLocation,
  SupermarketStore,
  UserRole,
} from '../types/grocery';

export interface HouseholdSnapshot {
  household: Household;
  purchases: Purchase[];
  shoppingList: ShoppingListItem[];
  pantry: PantryItem[];
  settlements: ExpenseSettlement[];
  notifications: HouseholdNotification[];
  feedbackMultipliers: Record<string, number>;
}

export interface HouseholdMembership {
  householdId: string;
  householdName: string;
  role: UserRole;
}

const MEMBER_ACCENTS = ['#2563eb', '#7c3aed', '#059669', '#e11d48', '#d97706', '#0891b2'];
const RECEIPTS_BUCKET = 'receipts';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function orUndefined<T>(v: T | null | undefined): T | undefined {
  return v === null || v === undefined ? undefined : v;
}

/** Server error tagged with what the app was doing; only the context is ever shown to the user. */
class RepositoryError extends Error {
  readonly context: string;
  constructor(context: string, message: string) {
    super(message);
    this.context = context;
  }
}

function throwIfError(error: { message: string } | null, context: string): void {
  if (error) {
    throw new RepositoryError(context, error.message);
  }
}

export function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // RFC4122 v4 fallback for very old browsers
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Turns Supabase / RPC error codes into short Spanish messages for the UI. */
export function describeSupabaseError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err ?? '');
  devLog('error', 'Supabase', err instanceof RepositoryError ? `${err.context}: ${raw}` : raw, {
    detail: err instanceof Error ? { name: err.name, stack: err.stack } : err,
  });
  const msg = raw.toLowerCase();
  if (msg.includes('invalid login credentials')) return 'Correo o contraseña incorrectos.';
  if (msg.includes('email not confirmed'))
    return 'Confirma tu correo antes de iniciar sesión (revisa tu bandeja de entrada).';
  if (msg.includes('user already registered')) return 'Ya existe una cuenta con ese correo.';
  if (msg.includes('password should be at least'))
    return 'La contraseña debe tener al menos 6 caracteres.';
  if (msg.includes('invalid_invite_code')) return 'Ese código de invitación no existe.';
  if (msg.includes('household_name_required')) return 'Ponle un nombre a tu hogar.';
  if (msg.includes('not_an_admin') || msg.includes('row-level security'))
    return 'Solo un administrador del hogar puede hacer este cambio.';
  if (msg.includes('failed to fetch') || msg.includes('network'))
    return 'Sin conexión con el servidor. Revisa tu internet e inténtalo de nuevo.';
  if (msg.includes('token has expired or is invalid') || msg.includes('otp_expired'))
    return 'El código no es válido o ya venció. Pide uno nuevo.';
  if (msg.includes('for security purposes, you can only request this after'))
    return 'Espera unos segundos antes de pedir otro correo.';
  if (msg.includes('email rate limit exceeded'))
    return 'Se alcanzó el límite de correos. Intenta más tarde.';
  if (msg.includes('rate limit')) return 'Demasiados intentos. Espera un momento.';
  // Never show raw server text (it can name tables, columns or constraints)
  if (err instanceof RepositoryError) {
    return `${err.context}: no se pudo completar. Inténtalo de nuevo.`;
  }
  return 'Ocurrió un error inesperado. Inténtalo de nuevo.';
}

// ---------------------------------------------------------------------------
// Row → domain mappers
// ---------------------------------------------------------------------------

/* eslint-disable @typescript-eslint/no-explicit-any */
type Row = Record<string, any>;

function mapMember(row: Row, idx: number): HouseholdMember {
  const profile: Row = row.profiles ?? {};
  return {
    id: row.user_id,
    name: profile.full_name || profile.email || 'Miembro',
    email: profile.email || '',
    role: row.role === 'admin' ? 'admin' : 'member',
    avatarUrl: profile.avatar_url || '',
    accentColor:
      profile.accent_color && profile.accent_color !== '#2563eb'
        ? profile.accent_color
        : MEMBER_ACCENTS[idx % MEMBER_ACCENTS.length],
    joinedAt: String(row.joined_at ?? '').slice(0, 10),
  };
}

function mapCategory(row: Row): CategoryBudget {
  return {
    name: row.name as GroceryCategory,
    icon: row.icon,
    color: row.color,
    monthlyAllocation: num(row.monthly_allocation),
    aisleOrder: num(row.aisle_order),
  };
}

function mapPurchaseItem(row: Row, supermarket: string): PurchaseItem {
  return {
    id: row.id,
    purchaseId: row.purchase_id,
    rawReceiptName: row.raw_receipt_name ?? row.normalized_name,
    normalizedName: row.normalized_name,
    canonicalName: row.canonical_name,
    category: row.category as GroceryCategory,
    quantity: num(row.quantity),
    unit: row.unit,
    baseUnitQuantity: num(row.base_unit_quantity),
    baseUnit: row.base_unit as BaseUnit,
    unitPrice: num(row.unit_price),
    totalPrice: num(row.total_price),
    isShared: Boolean(row.is_shared),
    createdBy: row.created_by,
    purchaseDate: String(row.purchase_date).slice(0, 10),
    supermarket,
  };
}

function mapPurchase(row: Row, imageUrl: string): Purchase {
  const items: Row[] = row.purchase_items ?? [];
  return {
    id: row.id,
    householdId: row.household_id,
    supermarket: row.supermarket,
    purchaseDate: String(row.purchase_date).slice(0, 10),
    createdBy: row.created_by,
    subtotal: num(row.subtotal),
    discounts: num(row.discounts),
    taxes: num(row.taxes),
    totalAmount: num(row.total_amount),
    receiptImageUrl: imageUrl,
    notes: orUndefined(row.notes),
    items: items
      .slice()
      .sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
      .map((it) => mapPurchaseItem(it, row.supermarket)),
  };
}

function mapShoppingItem(row: Row): ShoppingListItem {
  return {
    id: row.id,
    name: row.name,
    canonicalName: row.canonical_name || row.name,
    category: row.category as GroceryCategory,
    quantity: num(row.quantity),
    unit: row.unit,
    isChecked: Boolean(row.is_checked),
    checkedBy: orUndefined(row.checked_by),
    checkedAt: orUndefined(row.checked_at),
    matchedPurchaseId: orUndefined(row.matched_purchase_id),
    matchedReceiptItemName: orUndefined(row.matched_receipt_item_name),
    isPredicted: Boolean(row.is_predicted),
    predictedReason: orUndefined(row.predicted_reason),
    store: orUndefined(row.store),
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function mapPantryItem(row: Row): PantryItem {
  return {
    id: row.id,
    name: row.name,
    canonicalName: row.canonical_name,
    category: row.category as GroceryCategory,
    storageLocation: row.storage_location as StorageLocation,
    quantityLabel: row.quantity_label,
    baseQuantity: num(row.base_quantity),
    baseUnit: row.base_unit as BaseUnit,
    remainingPercentage: num(row.remaining_percentage),
    purchasedDate: String(row.purchased_date).slice(0, 10),
    estimatedExpiryDate: String(row.estimated_expiry_date).slice(0, 10),
    status: row.status,
    addedBy: row.added_by,
  };
}

function mapSettlement(row: Row): ExpenseSettlement {
  return {
    id: row.id,
    fromMemberId: row.from_member_id,
    toMemberId: row.to_member_id,
    amount: num(row.amount),
    note: row.note ?? '',
    settledAt: row.settled_at,
  };
}

function mapNotification(row: Row): HouseholdNotification {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    isRead: Boolean(row.is_read),
    createdAt: row.created_at,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// Memberships & onboarding
// ---------------------------------------------------------------------------

export async function listMyHouseholds(
  sb: SupabaseClient,
  userId: string
): Promise<HouseholdMembership[]> {
  const { data, error } = await sb
    .from('household_members')
    .select('household_id, role, joined_at, households(name)')
    .eq('user_id', userId)
    .order('joined_at', { ascending: true });
  throwIfError(error, 'Cargando hogares');
  return (data ?? []).map((r: Row) => ({
    householdId: r.household_id,
    householdName: (r.households as Row | null)?.name ?? 'Hogar',
    role: r.role === 'admin' ? 'admin' : 'member',
  }));
}

export async function createHousehold(
  sb: SupabaseClient,
  params: { name: string; monthlyBudget: number; supermarkets: SupermarketStore[] }
): Promise<string> {
  const { data, error } = await sb.rpc('create_household', {
    p_name: params.name,
    p_currency: 'CRC',
    p_language: 'es',
    p_monthly_budget: params.monthlyBudget,
    p_supermarkets: params.supermarkets,
  });
  throwIfError(error, 'Creando hogar');
  return data as string;
}

export async function joinHousehold(sb: SupabaseClient, inviteCode: string): Promise<string> {
  const { data, error } = await sb.rpc('join_household', { p_invite_code: inviteCode });
  throwIfError(error, 'Uniéndose al hogar');
  return data as string;
}

export async function leaveHousehold(
  sb: SupabaseClient,
  householdId: string,
  userId: string
): Promise<void> {
  const { error } = await sb
    .from('household_members')
    .delete()
    .eq('household_id', householdId)
    .eq('user_id', userId);
  throwIfError(error, 'Saliendo del hogar');
}

export async function regenerateInviteCode(
  sb: SupabaseClient,
  householdId: string
): Promise<string> {
  const { data, error } = await sb.rpc('regenerate_invite_code', {
    p_household_id: householdId,
  });
  throwIfError(error, 'Generando código');
  return data as string;
}

export async function updateMyProfile(
  sb: SupabaseClient,
  userId: string,
  patch: { fullName?: string }
): Promise<void> {
  const { error } = await sb
    .from('profiles')
    .update({ full_name: patch.fullName })
    .eq('id', userId);
  throwIfError(error, 'Actualizando perfil');
}

// ---------------------------------------------------------------------------
// Full snapshot load
// ---------------------------------------------------------------------------

async function signReceiptUrls(
  sb: SupabaseClient,
  paths: string[]
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (paths.length === 0) return map;
  const { data } = await sb.storage.from(RECEIPTS_BUCKET).createSignedUrls(paths, 60 * 60 * 6);
  (data ?? []).forEach((d) => {
    if (d.path && d.signedUrl) map.set(d.path, d.signedUrl);
  });
  return map;
}

export async function loadHouseholdSnapshot(
  sb: SupabaseClient,
  householdId: string
): Promise<HouseholdSnapshot> {
  const [hhRes, membersRes, catRes, purRes, slRes, panRes, setRes, notRes, cpRes] =
    await Promise.all([
      sb.from('households').select('*').eq('id', householdId).single(),
      sb
        .from('household_members')
        .select('user_id, role, joined_at, profiles(full_name, email, avatar_url, accent_color)')
        .eq('household_id', householdId)
        .order('joined_at', { ascending: true }),
      sb.from('categories').select('*').eq('household_id', householdId).order('aisle_order'),
      sb
        .from('purchases')
        .select('*, purchase_items(*)')
        .eq('household_id', householdId)
        .order('purchase_date', { ascending: false })
        .order('created_at', { ascending: false }),
      sb
        .from('shopping_list_items')
        .select('*')
        .eq('household_id', householdId)
        .order('created_at', { ascending: false }),
      sb
        .from('pantry_items')
        .select('*')
        .eq('household_id', householdId)
        .order('purchased_date', { ascending: false }),
      sb
        .from('expense_settlements')
        .select('*')
        .eq('household_id', householdId)
        .order('settled_at', { ascending: false }),
      sb
        .from('household_notifications')
        .select('*')
        .eq('household_id', householdId)
        .order('created_at', { ascending: false })
        .limit(50),
      sb
        .from('canonical_products')
        .select('name, feedback_multiplier')
        .eq('household_id', householdId),
    ]);

  throwIfError(hhRes.error, 'Cargando hogar');
  throwIfError(membersRes.error, 'Cargando miembros');
  throwIfError(catRes.error, 'Cargando categorías');
  throwIfError(purRes.error, 'Cargando compras');
  throwIfError(slRes.error, 'Cargando lista');
  throwIfError(panRes.error, 'Cargando despensa');
  throwIfError(setRes.error, 'Cargando saldos');
  throwIfError(notRes.error, 'Cargando notificaciones');
  throwIfError(cpRes.error, 'Cargando productos');

  const hh: Row = hhRes.data;
  const purchaseRows: Row[] = purRes.data ?? [];
  const signed = await signReceiptUrls(
    sb,
    purchaseRows.map((p) => p.receipt_image_path).filter(Boolean)
  );

  const feedbackMultipliers: Record<string, number> = {};
  (cpRes.data ?? []).forEach((r: Row) => {
    const m = num(r.feedback_multiplier);
    if (m && m !== 1) feedbackMultipliers[r.name] = m;
  });

  const household: Household = {
    id: hh.id,
    name: hh.name,
    inviteCode: hh.invite_code,
    monthlyBudget: num(hh.monthly_budget),
    currency: hh.currency === 'USD' ? 'USD' : 'CRC',
    language: hh.language === 'en' ? 'en' : 'es',
    restockLookbackMonths: ([3, 6, 12].includes(num(hh.restock_lookback_months))
      ? num(hh.restock_lookback_months)
      : 6) as 3 | 6 | 12,
    restockAlertDays: num(hh.restock_alert_days) || 2,
    minPurchasesForPrediction: num(hh.min_purchases_for_prediction) || 3,
    members: (membersRes.data ?? []).map((r: Row, i: number) => mapMember(r, i)),
    categories: (catRes.data ?? []).map(mapCategory),
    supermarkets: Array.isArray(hh.supermarkets) ? (hh.supermarkets as SupermarketStore[]) : [],
  };

  return {
    household,
    purchases: purchaseRows.map((p) =>
      mapPurchase(p, p.receipt_image_path ? signed.get(p.receipt_image_path) ?? '' : '')
    ),
    shoppingList: (slRes.data ?? []).map(mapShoppingItem),
    pantry: (panRes.data ?? []).map(mapPantryItem),
    settlements: (setRes.data ?? []).map(mapSettlement),
    notifications: (notRes.data ?? []).map(mapNotification),
    feedbackMultipliers,
  };
}

// ---------------------------------------------------------------------------
// Household settings
// ---------------------------------------------------------------------------

export async function updateHouseholdSettings(
  sb: SupabaseClient,
  householdId: string,
  patch: Partial<
    Pick<
      Household,
      | 'name'
      | 'monthlyBudget'
      | 'currency'
      | 'language'
      | 'restockLookbackMonths'
      | 'restockAlertDays'
      | 'minPurchasesForPrediction'
    >
  >
): Promise<void> {
  const row: Row = { updated_at: new Date().toISOString() };
  if (patch.name !== undefined) row.name = patch.name;
  if (patch.monthlyBudget !== undefined) row.monthly_budget = patch.monthlyBudget;
  if (patch.currency !== undefined) row.currency = patch.currency;
  if (patch.language !== undefined) row.language = patch.language;
  if (patch.restockLookbackMonths !== undefined)
    row.restock_lookback_months = patch.restockLookbackMonths;
  if (patch.restockAlertDays !== undefined) row.restock_alert_days = patch.restockAlertDays;
  if (patch.minPurchasesForPrediction !== undefined)
    row.min_purchases_for_prediction = patch.minPurchasesForPrediction;

  // .select() makes a silent RLS rejection (0 rows updated) visible as an error
  const { data, error } = await sb.from('households').update(row).eq('id', householdId).select('id');
  throwIfError(error, 'Guardando ajustes del hogar');
  if (!data || data.length === 0) throw new Error('not_an_admin');
}

export async function updateSupermarkets(
  sb: SupabaseClient,
  householdId: string,
  supermarkets: SupermarketStore[]
): Promise<void> {
  const { error } = await sb.rpc('update_household_supermarkets', {
    p_household_id: householdId,
    p_supermarkets: supermarkets,
  });
  throwIfError(error, 'Guardando supermercados');
}

export async function updateMemberRole(
  sb: SupabaseClient,
  householdId: string,
  userId: string,
  role: UserRole
): Promise<void> {
  const { data, error } = await sb
    .from('household_members')
    .update({ role })
    .eq('household_id', householdId)
    .eq('user_id', userId)
    .select('user_id');
  throwIfError(error, 'Cambiando rol');
  if (!data || data.length === 0) throw new Error('not_an_admin');
}

// ---------------------------------------------------------------------------
// Purchases & receipts
// ---------------------------------------------------------------------------

async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const res = await fetch(dataUrl);
  return res.blob();
}

/** Downscales camera photos so receipts upload fast on mobile data. */
async function compressImage(blob: Blob, maxSide = 1600): Promise<Blob> {
  if (!blob.type.startsWith('image/') || blob.type === 'image/svg+xml') return blob;
  try {
    const bitmap = await createImageBitmap(blob);
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && blob.size < 900_000) return blob;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const out = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', 0.82)
    );
    return out ?? blob;
  } catch {
    return blob;
  }
}

async function uploadReceiptImage(
  sb: SupabaseClient,
  householdId: string,
  purchaseId: string,
  imageUrl: string
): Promise<string | null> {
  if (!imageUrl || !imageUrl.startsWith('data:')) return null;
  try {
    const blob = await compressImage(await dataUrlToBlob(imageUrl));
    const ext =
      blob.type === 'image/svg+xml'
        ? 'svg'
        : blob.type === 'image/png'
          ? 'png'
          : blob.type === 'application/pdf'
            ? 'pdf'
            : /xml/.test(blob.type)
              ? 'xml'
              : 'jpg';
    const path = `${householdId}/${purchaseId}.${ext}`;
    const { error } = await sb.storage
      .from(RECEIPTS_BUCKET)
      .upload(path, blob, { contentType: blob.type || 'image/jpeg', upsert: true });
    if (error) return null;
    return path;
  } catch {
    return null;
  }
}

export async function insertPurchase(
  sb: SupabaseClient,
  householdId: string,
  purchase: Purchase
): Promise<void> {
  const imagePath = await uploadReceiptImage(
    sb,
    householdId,
    purchase.id,
    purchase.receiptImageUrl
  );

  const { error } = await sb.from('purchases').insert({
    id: purchase.id,
    household_id: householdId,
    created_by: purchase.createdBy,
    supermarket: purchase.supermarket,
    purchase_date: purchase.purchaseDate,
    subtotal: purchase.subtotal,
    discounts: purchase.discounts,
    taxes: purchase.taxes,
    total_amount: purchase.totalAmount,
    receipt_image_path: imagePath,
    notes: purchase.notes ?? null,
  });
  throwIfError(error, 'Guardando factura');

  if (purchase.items.length > 0) {
    const { error: itemsError } = await sb.from('purchase_items').insert(
      purchase.items.map((it) => ({
        id: it.id,
        purchase_id: purchase.id,
        household_id: householdId,
        raw_receipt_name: it.rawReceiptName,
        normalized_name: it.normalizedName,
        canonical_name: it.canonicalName,
        category: it.category,
        quantity: it.quantity,
        unit: it.unit,
        base_unit_quantity: it.baseUnitQuantity,
        base_unit: it.baseUnit,
        unit_price: it.unitPrice,
        total_price: it.totalPrice,
        is_shared: it.isShared,
        created_by: it.createdBy,
        purchase_date: it.purchaseDate,
      }))
    );
    throwIfError(itemsError, 'Guardando productos de la factura');
  }
}

function purchaseItemRows(householdId: string, purchase: Purchase) {
  return purchase.items.map((it) => ({
    id: it.id,
    purchase_id: purchase.id,
    household_id: householdId,
    raw_receipt_name: it.rawReceiptName,
    normalized_name: it.normalizedName,
    canonical_name: it.canonicalName,
    category: it.category,
    quantity: it.quantity,
    unit: it.unit,
    base_unit_quantity: it.baseUnitQuantity,
    base_unit: it.baseUnit,
    unit_price: it.unitPrice,
    total_price: it.totalPrice,
    is_shared: it.isShared,
    created_by: it.createdBy,
    purchase_date: it.purchaseDate,
  }));
}

/** Saves an edited receipt: header fields in place, line items replaced. The image is kept. */
export async function updatePurchase(
  sb: SupabaseClient,
  householdId: string,
  purchase: Purchase
): Promise<void> {
  const { error } = await sb
    .from('purchases')
    .update({
      created_by: purchase.createdBy,
      supermarket: purchase.supermarket,
      purchase_date: purchase.purchaseDate,
      subtotal: purchase.subtotal,
      discounts: purchase.discounts,
      taxes: purchase.taxes,
      total_amount: purchase.totalAmount,
      notes: purchase.notes ?? null,
    })
    .eq('id', purchase.id);
  throwIfError(error, 'Actualizando factura');

  const { error: deleteError } = await sb.from('purchase_items').delete().eq('purchase_id', purchase.id);
  throwIfError(deleteError, 'Actualizando productos de la factura');

  if (purchase.items.length > 0) {
    const { error: itemsError } = await sb
      .from('purchase_items')
      .insert(purchaseItemRows(householdId, purchase));
    throwIfError(itemsError, 'Actualizando productos de la factura');
  }
}

/** Deletes a receipt; its items go with it (ON DELETE CASCADE) and list items are unlinked. */
export async function deletePurchase(
  sb: SupabaseClient,
  householdId: string,
  purchaseId: string
): Promise<void> {
  const { error } = await sb.from('purchases').delete().eq('id', purchaseId);
  throwIfError(error, 'Eliminando factura');
  // Best effort: the photo may not exist or may use another extension
  await sb.storage
    .from(RECEIPTS_BUCKET)
    .remove(['jpg', 'png', 'svg'].map((ext) => `${householdId}/${purchaseId}.${ext}`))
    .catch(() => undefined);
}

export async function setPurchaseItemShared(
  sb: SupabaseClient,
  itemId: string,
  isShared: boolean
): Promise<void> {
  const { error } = await sb.from('purchase_items').update({ is_shared: isShared }).eq('id', itemId);
  throwIfError(error, 'Actualizando producto');
}

// ---------------------------------------------------------------------------
// Shopping list
// ---------------------------------------------------------------------------

export async function insertShoppingItems(
  sb: SupabaseClient,
  householdId: string,
  items: ShoppingListItem[]
): Promise<void> {
  if (items.length === 0) return;
  const { error } = await sb.from('shopping_list_items').insert(
    items.map((it) => ({
      id: it.id,
      household_id: householdId,
      name: it.name,
      canonical_name: it.canonicalName,
      category: it.category,
      quantity: it.quantity,
      unit: it.unit,
      is_checked: it.isChecked,
      is_predicted: it.isPredicted,
      predicted_reason: it.predictedReason ?? null,
      store: it.store ?? null,
      created_by: it.createdBy,
      created_at: it.createdAt,
    }))
  );
  throwIfError(error, 'Añadiendo a la lista');
}

export async function updateShoppingItems(
  sb: SupabaseClient,
  items: ShoppingListItem[]
): Promise<void> {
  await Promise.all(
    items.map(async (it) => {
      const { error } = await sb
        .from('shopping_list_items')
        .update({
          is_checked: it.isChecked,
          checked_by: it.checkedBy ?? null,
          checked_at: it.checkedAt ?? null,
          matched_purchase_id: it.matchedPurchaseId ?? null,
          matched_receipt_item_name: it.matchedReceiptItemName ?? null,
          store: it.store ?? null,
        })
        .eq('id', it.id);
      throwIfError(error, 'Actualizando lista');
    })
  );
}

export async function deleteShoppingItems(sb: SupabaseClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await sb.from('shopping_list_items').delete().in('id', ids);
  throwIfError(error, 'Eliminando de la lista');
}

// ---------------------------------------------------------------------------
// Pantry
// ---------------------------------------------------------------------------

export async function insertPantryItems(
  sb: SupabaseClient,
  householdId: string,
  items: PantryItem[]
): Promise<void> {
  if (items.length === 0) return;
  const { error } = await sb.from('pantry_items').insert(
    items.map((p) => ({
      id: p.id,
      household_id: householdId,
      name: p.name,
      canonical_name: p.canonicalName,
      category: p.category,
      storage_location: p.storageLocation,
      quantity_label: p.quantityLabel,
      base_quantity: p.baseQuantity,
      base_unit: p.baseUnit,
      remaining_percentage: p.remainingPercentage,
      purchased_date: p.purchasedDate,
      estimated_expiry_date: p.estimatedExpiryDate,
      status: p.status,
      added_by: p.addedBy,
    }))
  );
  throwIfError(error, 'Guardando despensa');
}

export async function updatePantryItems(sb: SupabaseClient, items: PantryItem[]): Promise<void> {
  await Promise.all(
    items.map(async (p) => {
      const { error } = await sb
        .from('pantry_items')
        .update({
          remaining_percentage: Math.round(p.remainingPercentage),
          status: p.status,
          updated_at: new Date().toISOString(),
        })
        .eq('id', p.id);
      throwIfError(error, 'Actualizando despensa');
    })
  );
}

// ---------------------------------------------------------------------------
// Restock feedback & predictions
// ---------------------------------------------------------------------------

export async function saveFeedbackMultiplier(
  sb: SupabaseClient,
  householdId: string,
  canonicalName: string,
  multiplier: number
): Promise<void> {
  const norm = normalizeReceiptProduct(canonicalName);
  const { error } = await sb.from('canonical_products').upsert(
    {
      household_id: householdId,
      name: canonicalName,
      category: norm.category,
      base_unit: norm.baseUnit,
      feedback_multiplier: multiplier,
      default_shelf_life_days: norm.shelfLifeDays,
    },
    { onConflict: 'household_id,name' }
  );
  throwIfError(error, 'Guardando ajuste de predicción');
}

/** Mirrors client-side predictions so the daily pg_cron job can auto-add items. */
export async function syncRestockPredictions(
  sb: SupabaseClient,
  householdId: string,
  predictions: RestockPrediction[]
): Promise<void> {
  if (predictions.length === 0) return;
  const { error } = await sb.from('restock_predictions').upsert(
    predictions.map((p) => ({
      household_id: householdId,
      canonical_name: p.canonicalName,
      category: p.category,
      base_unit: p.baseUnit,
      weighted_daily_rate: Number(p.weightedDailyRate.toFixed(4)),
      last_purchase_date: p.lastPurchaseDate,
      last_purchase_base_qty: p.lastPurchaseBaseQty,
      last_purchase_display_qty: p.lastPurchaseDisplayQty,
      expected_duration_days: Number(p.expectedDurationDays.toFixed(2)),
      estimated_days_remaining: Number(p.estimatedDaysRemaining.toFixed(2)),
      confidence_level: p.confidenceLevel,
      purchase_count: p.purchaseCount,
      grouped_variants: p.groupedVariants,
      ai_explanation: p.aiExplanation,
      updated_at: new Date().toISOString(),
    })),
    { onConflict: 'household_id,canonical_name' }
  );
  throwIfError(error, 'Sincronizando predicciones');
}

// ---------------------------------------------------------------------------
// Settlements & notifications
// ---------------------------------------------------------------------------

export async function insertSettlement(
  sb: SupabaseClient,
  householdId: string,
  s: ExpenseSettlement
): Promise<void> {
  const { error } = await sb.from('expense_settlements').insert({
    id: s.id,
    household_id: householdId,
    from_member_id: s.fromMemberId,
    to_member_id: s.toMemberId,
    amount: s.amount,
    note: s.note,
    settled_at: s.settledAt,
  });
  throwIfError(error, 'Registrando liquidación');
}

export async function insertNotification(
  sb: SupabaseClient,
  householdId: string,
  n: HouseholdNotification
): Promise<void> {
  const { error } = await sb.from('household_notifications').insert({
    id: n.id,
    household_id: householdId,
    type: n.type,
    title: n.title,
    message: n.message,
    is_read: n.isRead,
    created_at: n.createdAt,
  });
  throwIfError(error, 'Guardando notificación');
}

export async function markNotificationsRead(
  sb: SupabaseClient,
  householdId: string
): Promise<void> {
  const { error } = await sb
    .from('household_notifications')
    .update({ is_read: true })
    .eq('household_id', householdId)
    .eq('is_read', false);
  throwIfError(error, 'Marcando notificaciones');
}
