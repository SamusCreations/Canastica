// ============================================================================
// Offline support for cloud households:
//  - the last household snapshot is cached per household so the app opens without signal
//  - shopping list / pantry changes made offline go to a queue that is replayed in order
//    when the connection comes back (last write wins, like the online write-through)
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import type { PantryItem, ShoppingListItem } from '../types/grocery';
import {
  deletePantryItems,
  deleteShoppingItems,
  HouseholdSnapshot,
  insertPantryItems,
  insertShoppingItems,
  updateShoppingItems,
} from '../services/householdRepository';
import { devLog } from './devConsole';

const SNAPSHOT_PREFIX = 'canastica_snapshot_v1_';
const QUEUE_KEY = 'canastica_offline_queue_v1';

export type OfflineOp =
  | { kind: 'insertList'; householdId: string; items: ShoppingListItem[] }
  | { kind: 'updateList'; items: ShoppingListItem[] }
  | { kind: 'deleteList'; ids: string[] }
  | { kind: 'insertPantry'; householdId: string; items: PantryItem[] }
  | { kind: 'deletePantry'; ids: string[] };

interface QueuedOp {
  id: string;
  queuedAt: string;
  op: OfflineOp;
}

// ---------------------------------------------------------------------------
// Snapshot cache
// ---------------------------------------------------------------------------

export function saveSnapshot(householdId: string, snap: HouseholdSnapshot): void {
  if (!householdId) return;
  const key = SNAPSHOT_PREFIX + householdId;
  try {
    localStorage.setItem(key, JSON.stringify({ savedAt: new Date().toISOString(), snap }));
  } catch {
    // Storage full: keep at least what's needed in the store (list, pantry, household)
    try {
      localStorage.setItem(
        key,
        JSON.stringify({ savedAt: new Date().toISOString(), snap: { ...snap, purchases: snap.purchases.slice(0, 30) } })
      );
    } catch {
      // ignore
    }
  }
}

export function loadSnapshot(householdId: string): { savedAt: string; snap: HouseholdSnapshot } | null {
  try {
    const raw = localStorage.getItem(SNAPSHOT_PREFIX + householdId);
    return raw ? (JSON.parse(raw) as { savedAt: string; snap: HouseholdSnapshot }) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Write queue
// ---------------------------------------------------------------------------

const queueListeners = new Set<() => void>();
let queueCache: QueuedOp[] | null = null;

function readQueue(): QueuedOp[] {
  if (queueCache) return queueCache;
  try {
    queueCache = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]') as QueuedOp[];
  } catch {
    queueCache = [];
  }
  return queueCache;
}

function writeQueue(next: QueuedOp[]) {
  queueCache = next;
  try {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(next));
  } catch {
    // ignore
  }
  queueListeners.forEach((l) => l());
}

export function getOfflineQueue(): QueuedOp[] {
  return readQueue();
}

export function subscribeOfflineQueue(listener: () => void): () => void {
  queueListeners.add(listener);
  return () => queueListeners.delete(listener);
}

export function enqueueOfflineOp(op: OfflineOp): void {
  writeQueue([
    ...readQueue(),
    { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, queuedAt: new Date().toISOString(), op },
  ]);
  devLog('info', 'Sin conexión', `Cambio guardado para subir luego (${op.kind})`);
}

export function isNetworkError(err: unknown): boolean {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  const msg = (err instanceof Error ? err.message : String(err ?? '')).toLowerCase();
  return msg.includes('failed to fetch') || msg.includes('networkerror') || msg.includes('load failed') || msg.includes('network request failed');
}

export async function runOfflineOp(sb: SupabaseClient, op: OfflineOp): Promise<void> {
  switch (op.kind) {
    case 'insertList':
      return insertShoppingItems(sb, op.householdId, op.items);
    case 'updateList':
      return updateShoppingItems(sb, op.items);
    case 'deleteList':
      return deleteShoppingItems(sb, op.ids);
    case 'insertPantry':
      return insertPantryItems(sb, op.householdId, op.items);
    case 'deletePantry':
      return deletePantryItems(sb, op.ids);
  }
}

let flushing: Promise<number> | null = null;

/**
 * Replays the queue in order. Stops at the first network error (keeps the rest);
 * any other error drops that change (e.g. the item was deleted meanwhile by someone else).
 * Resolves with the number of changes that were uploaded.
 */
export function flushOfflineQueue(sb: SupabaseClient): Promise<number> {
  if (flushing) return flushing;
  flushing = (async () => {
    let uploaded = 0;
    while (readQueue().length > 0) {
      const [head, ...rest] = readQueue();
      try {
        await runOfflineOp(sb, head.op);
        uploaded += 1;
      } catch (err) {
        if (isNetworkError(err)) break;
        devLog('warn', 'Sin conexión', `Se descartó un cambio que ya no aplica (${head.op.kind})`, {
          detail: err instanceof Error ? err.message : String(err),
        });
      }
      writeQueue(rest);
    }
    if (uploaded > 0) devLog('success', 'Sin conexión', `${uploaded} cambios subidos al volver la conexión`);
    return uploaded;
  })().finally(() => {
    flushing = null;
  });
  return flushing;
}
