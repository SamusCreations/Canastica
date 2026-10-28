// ============================================================================
// Developer console log: in-memory only (never persisted), max 300 entries.
// Entries are recorded only after the server confirmed this account is a
// developer (dev-status), so regular users never keep raw error details.
// ============================================================================

import { recordAppError } from './appContext';

export type DevLogLevel = 'info' | 'success' | 'warn' | 'error';

export interface DevLogEntry {
  id: number;
  time: string; // ISO
  level: DevLogLevel;
  source: string; // e.g. "IA", "Supabase", "Realtime", "Escaneo"
  message: string;
  durationMs?: number;
  detail?: unknown;
}

export interface DevStatus {
  isDeveloper: boolean;
  config?: Record<string, unknown>;
}

const MAX_ENTRIES = 300;
let entries: DevLogEntry[] = [];
let nextId = 1;
let developer = false;
let lastStatus: DevStatus | null = null;
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

export function subscribeDevConsole(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function isDeveloperMode(): boolean {
  return developer;
}

export function getDevStatus(): DevStatus | null {
  return lastStatus;
}

export function setDevStatus(status: DevStatus | null): void {
  lastStatus = status;
  developer = Boolean(status?.isDeveloper);
  if (!developer) entries = [];
  emit();
}

export function getDevLog(): DevLogEntry[] {
  return entries;
}

export function clearDevLog(): void {
  entries = [];
  emit();
}

/**
 * Records an entry only in developer mode. Errors also go (trimmed and scrubbed)
 * to the small buffer attached to problem reports, for every user.
 */
export function devLog(
  level: DevLogLevel,
  source: string,
  message: string,
  extra: { durationMs?: number; detail?: unknown } = {}
): void {
  if (level === 'error') recordAppError(source, message);
  if (!developer) return;
  entries = [
    { id: nextId++, time: new Date().toISOString(), level, source, message, ...extra },
    ...entries,
  ].slice(0, MAX_ENTRIES);
  emit();
}

/** Plain-text dump for the "copy log" button. */
export function formatDevLog(): string {
  return [...entries]
    .reverse()
    .map((e) => {
      const head = `${e.time} [${e.level.toUpperCase()}] ${e.source}: ${e.message}${
        e.durationMs !== undefined ? ` (${e.durationMs} ms)` : ''
      }`;
      return e.detail === undefined ? head : `${head}\n${JSON.stringify(e.detail, null, 2)}`;
    })
    .join('\n');
}

/** Who and where, shown in the developer console's configuration tab. */
export interface DevContext {
  userId?: string | null;
  email?: string | null;
  householdId?: string | null;
}

let devContext: DevContext = {};

export function setDevContext(next: DevContext): void {
  devContext = { ...devContext, ...next };
  emit();
}

export function getDevContext(): DevContext {
  return devContext;
}
