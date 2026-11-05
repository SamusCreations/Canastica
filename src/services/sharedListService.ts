// ============================================================================
// Shared shopping list links: management for household members (RLS on
// shared_lists) and the public token-based API used by /l/<token>.
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { GroceryCategory, ShoppingListItem } from '../types/grocery';

export interface SharedLink {
  id: string;
  token: string;
  createdBy: string;
  canCheck: boolean;
  canAdd: boolean;
  canDelete: boolean;
  expiresAt: string | null;
  isActive: boolean;
  createdAt: string;
}

export type LinkExpiry = '24h' | '7d' | 'never';

export interface PublicSharedList {
  householdName: string;
  canCheck: boolean;
  canAdd: boolean;
  canDelete: boolean;
  expiresAt: string | null;
  items: {
    id: string;
    name: string;
    quantity: number;
    unit: string;
    category: GroceryCategory;
    isChecked: boolean;
    store: string | null;
  }[];
}

export function sharedLinkUrl(token: string): string {
  return `${window.location.origin}/l/${token}`;
}

export const SHARED_LINK_PATH = /^\/l\/([A-Za-z0-9_-]{20,64})\/?$/;

function randomToken(): string {
  const bytes = new Uint8Array(18);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function mapLink(row: Record<string, unknown>): SharedLink {
  return {
    id: row.id as string,
    token: row.token as string,
    createdBy: row.created_by as string,
    canCheck: Boolean(row.can_check),
    canAdd: Boolean(row.can_add),
    canDelete: Boolean(row.can_delete),
    expiresAt: (row.expires_at as string | null) ?? null,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at as string,
  };
}

export function isLinkUsable(link: SharedLink): boolean {
  return link.isActive && (!link.expiresAt || new Date(link.expiresAt).getTime() > Date.now());
}

export async function listSharedLinks(sb: SupabaseClient, householdId: string): Promise<SharedLink[]> {
  const { data, error } = await sb
    .from('shared_lists')
    .select('*')
    .eq('household_id', householdId)
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapLink);
}

export async function createSharedLink(
  sb: SupabaseClient,
  householdId: string,
  userId: string,
  perms: { canCheck: boolean; canAdd: boolean; canDelete: boolean },
  expiry: LinkExpiry
): Promise<SharedLink> {
  const hours = expiry === '24h' ? 24 : expiry === '7d' ? 24 * 7 : null;
  const { data, error } = await sb
    .from('shared_lists')
    .insert({
      household_id: householdId,
      token: randomToken(),
      created_by: userId,
      can_check: perms.canCheck,
      can_add: perms.canAdd,
      can_delete: perms.canDelete,
      expires_at: hours ? new Date(Date.now() + hours * 3600_000).toISOString() : null,
    })
    .select('*')
    .single();
  if (error) throw new Error(error.message);
  return mapLink(data);
}

export async function updateSharedLink(
  sb: SupabaseClient,
  id: string,
  patch: Partial<Pick<SharedLink, 'canCheck' | 'canAdd' | 'canDelete' | 'isActive'>>
): Promise<void> {
  const row: Record<string, boolean> = {};
  if (patch.canCheck !== undefined) row.can_check = patch.canCheck;
  if (patch.canAdd !== undefined) row.can_add = patch.canAdd;
  if (patch.canDelete !== undefined) row.can_delete = patch.canDelete;
  if (patch.isActive !== undefined) row.is_active = patch.isActive;
  const { error } = await sb.from('shared_lists').update(row).eq('id', id);
  if (error) throw new Error(error.message);
}

/** Plain-text version of the list for the WhatsApp message, readable without opening the link. */
export function listAsText(householdName: string, items: ShoppingListItem[], url: string): string {
  const pending = items.filter((i) => !i.isChecked);
  const lines = pending.map((i) => `• ${i.name}${i.quantity && !(i.quantity === 1 && /^unid/.test(i.unit)) ? ` (${i.quantity} ${i.unit})` : ''}`);
  return [`🛒 Lista de compras · ${householdName}`, ...lines, '', `Ver y actualizar en vivo: ${url}`].join('\n');
}

// ---------------------------------------------------------------------------
// Public API (anyone with the link)
// ---------------------------------------------------------------------------

export type SharedListError = 'invalid_link' | 'not_allowed' | 'rate_limited' | 'name_required' | 'network';

function toSharedError(message: string): SharedListError {
  if (message.includes('invalid_link')) return 'invalid_link';
  if (message.includes('not_allowed')) return 'not_allowed';
  if (message.includes('rate_limited')) return 'rate_limited';
  if (message.includes('name_required')) return 'name_required';
  return 'network';
}

export class SharedListApiError extends Error {
  readonly code: SharedListError;
  constructor(code: SharedListError) {
    super(code);
    this.code = code;
  }
}

async function rpc<T>(sb: SupabaseClient, fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new SharedListApiError(toSharedError(error.message));
  return data as T;
}

export const fetchPublicList = (sb: SupabaseClient, token: string) =>
  rpc<PublicSharedList>(sb, 'shared_list_view', { p_token: token });

export const publicToggle = (sb: SupabaseClient, token: string, itemId: string, checked: boolean, actor: string) =>
  rpc<void>(sb, 'shared_list_toggle', { p_token: token, p_item_id: itemId, p_checked: checked, p_actor: actor });

export const publicAdd = (sb: SupabaseClient, token: string, name: string, quantity: number, unit: string, actor: string) =>
  rpc<string>(sb, 'shared_list_add', { p_token: token, p_name: name, p_quantity: quantity, p_unit: unit, p_actor: actor });

export const publicDelete = (sb: SupabaseClient, token: string, itemId: string, actor: string) =>
  rpc<void>(sb, 'shared_list_delete', { p_token: token, p_item_id: itemId, p_actor: actor });
