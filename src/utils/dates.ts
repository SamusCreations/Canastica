// ============================================================================
// Canastica Date Helpers
// The demo dataset is frozen around 2026-10-24, so demo mode pins the
// reference date; real Supabase households always use the device's today.
// ============================================================================

import { LanguageCode } from '../types/grocery';

export const DEMO_REFERENCE_DATE = '2026-10-24';

let pinnedReferenceDate: string | null = null;

export function setReferenceDate(iso: string | null): void {
  pinnedReferenceDate = iso;
}

function toLocalIso(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Today's date as YYYY-MM-DD (or the pinned demo date). */
export function getTodayIso(): string {
  return pinnedReferenceDate ?? toLocalIso(new Date());
}

export function parseIso(iso: string): Date {
  return new Date(`${iso.slice(0, 10)}T12:00:00`);
}

export function addDaysIso(iso: string, days: number): string {
  const d = parseIso(iso);
  d.setDate(d.getDate() + days);
  return toLocalIso(d);
}

/** Month prefix (YYYY-MM) relative to today, offset in months. */
export function getMonthPrefix(offsetMonths = 0): string {
  const d = parseIso(getTodayIso());
  d.setDate(1);
  d.setMonth(d.getMonth() + offsetMonths);
  return toLocalIso(d).slice(0, 7);
}

export function getCurrentMonthPrefix(): string {
  return getMonthPrefix(0);
}

export function getPreviousMonthPrefix(): string {
  return getMonthPrefix(-1);
}

const MONTHS_ES = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function monthName(prefix: string, lang: LanguageCode = 'es', short = false): string {
  const idx = Number(prefix.slice(5, 7)) - 1;
  const name = (lang === 'es' ? MONTHS_ES : MONTHS_EN)[idx] ?? prefix;
  return short ? name.slice(0, 3) : name;
}

/** "Octubre 2026" style label for a YYYY-MM prefix. */
export function monthLabel(prefix: string, lang: LanguageCode = 'es', short = false): string {
  return `${monthName(prefix, lang, short)} ${prefix.slice(0, 4)}`;
}

/** Days in the month of the given prefix, and the day-of-month of today when it is the current month. */
export function monthProgress(prefix: string): { daysInMonth: number; dayOfMonth: number } {
  const [y, m] = prefix.split('-').map(Number);
  const daysInMonth = new Date(y, m, 0).getDate();
  const today = getTodayIso();
  const dayOfMonth = today.startsWith(prefix) ? Number(today.slice(8, 10)) : daysInMonth;
  return { daysInMonth, dayOfMonth };
}

export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((parseIso(toIso).getTime() - parseIso(fromIso).getTime()) / 86_400_000);
}
