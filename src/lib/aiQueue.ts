// ============================================================================
// Queue for AI requests that could not run (AI busy, offline or too slow).
// Kept on this device in IndexedDB (receipt photos are too big for localStorage)
// and retried in the background until the AI answers again.
// ============================================================================
import type { ParsedShoppingInputItem, ScannedReceiptResult } from '../services/geminiAndSupabaseService';

export type AiQueueEntry =
  | {
      id: string;
      kind: 'receipt';
      householdId: string;
      createdAt: string;
      attempts: number;
      status: 'pending' | 'ready';
      dataUrl: string;
      language: 'es' | 'en';
      result?: ScannedReceiptResult;
    }
  | {
      id: string;
      kind: 'shopping';
      householdId: string;
      createdAt: string;
      attempts: number;
      status: 'pending' | 'ready';
      text: string;
      language: 'es' | 'en';
      result?: ParsedShoppingInputItem[];
    };

/** How long the app waits for the AI before offering the queue or manual entry. */
export const AI_WAIT_LIMIT_MS = 30_000;

const DB_NAME = 'canastica_ai_queue';
const STORE = 'entries';
const MAX_ENTRIES = 20;

let entries: AiQueueEntry[] = [];
let loaded = false;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function withStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  try {
    const db = await openDb();
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Private mode or blocked storage: the queue still works for this session
    return undefined;
  }
}

export async function loadAiQueue(): Promise<void> {
  if (loaded) return;
  const stored = await withStore<AiQueueEntry[]>('readonly', (s) => s.getAll() as IDBRequest<AiQueueEntry[]>);
  loaded = true;
  const known = new Set(entries.map((e) => e.id));
  entries = [...entries, ...(stored ?? []).filter((e) => !known.has(e.id))].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt)
  );
  emit();
}

export function getAiQueue(): AiQueueEntry[] {
  return entries;
}

export function subscribeAiQueue(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

type NewEntry =
  | Pick<Extract<AiQueueEntry, { kind: 'receipt' }>, 'kind' | 'householdId' | 'dataUrl' | 'language'>
  | Pick<Extract<AiQueueEntry, { kind: 'shopping' }>, 'kind' | 'householdId' | 'text' | 'language'>;

/** Adds a request to the queue; returns false when the queue is full. */
export function enqueueAiRequest(entry: NewEntry): AiQueueEntry | null {
  if (entries.length >= MAX_ENTRIES) return null;
  const full = {
    ...entry,
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    attempts: 0,
    status: 'pending',
  } as AiQueueEntry;
  entries = [...entries, full];
  emit();
  void withStore('readwrite', (s) => s.put(full));
  return full;
}

export function updateAiQueueEntry(id: string, patch: Partial<AiQueueEntry>): void {
  let changed: AiQueueEntry | undefined;
  entries = entries.map((e) => {
    if (e.id !== id) return e;
    changed = { ...e, ...patch } as AiQueueEntry;
    return changed;
  });
  if (!changed) return;
  emit();
  const toStore = changed;
  void withStore('readwrite', (s) => s.put(toStore));
}

export function removeAiQueueEntry(id: string): void {
  if (!entries.some((e) => e.id === id)) return;
  entries = entries.filter((e) => e.id !== id);
  emit();
  void withStore('readwrite', (s) => s.delete(id));
}

export type TimedResult<T> = { timedOut: true; late: Promise<T> } | { timedOut: false; value: T };

/** Resolves with the value, or with `timedOut` after `ms` (the original promise keeps running). */
export async function withAiTimeout<T>(promise: Promise<T>, ms = AI_WAIT_LIMIT_MS): Promise<TimedResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), ms);
  });
  const winner = await Promise.race([promise, timeout]);
  clearTimeout(timer);
  if (winner === 'timeout') return { timedOut: true, late: promise };
  return { timedOut: false, value: winner as T };
}

/** Shows a system notification when the user allowed them (best effort). */
export function notifyAiQueue(title: string, body: string): void {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted' && document.hidden) {
      new Notification(title, { body, icon: '/favicon.svg' });
    }
  } catch {
    // Some mobile browsers only allow notifications from a service worker
  }
}

export function askNotificationPermission(): void {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      void Notification.requestPermission();
    }
  } catch {
    // ignore
  }
}
