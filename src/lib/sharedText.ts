// ============================================================================
// "Compartir a Canastica": text shared from WhatsApp or any app arrives at
// /compartir?text=... (Android share target or the iPhone Shortcut). It is kept in
// sessionStorage so it survives the sign-in redirect and a household switch.
// ============================================================================

import { MAX_SHOPPING_TEXT_CHARS } from '../services/geminiAndSupabaseService';

const SHARED_TEXT_KEY = 'canastica_shared_text_v1';
export const SHARE_PATH = '/compartir';
const MAX_SHARED_CHARS = 4000;

/** Reads a shared list from the URL once at startup and cleans the address bar. */
export function captureSharedTextFromUrl(): string | null {
  if (window.location.pathname.replace(/\/$/, '') === SHARE_PATH) {
    const params = new URLSearchParams(window.location.search);
    const parts = [params.get('title'), params.get('text'), params.get('url')]
      .map((p) => (p ?? '').trim())
      .filter(Boolean);
    // Many apps repeat the text in title and text: keep each piece once
    const text = [...new Set(parts)].join('\n').slice(0, MAX_SHARED_CHARS);
    if (text) setPendingSharedText(text);
    window.history.replaceState(null, '', '/');
  }
  return getPendingSharedText();
}

export function getPendingSharedText(): string | null {
  try {
    return sessionStorage.getItem(SHARED_TEXT_KEY);
  } catch {
    return null;
  }
}

export function setPendingSharedText(text: string | null): void {
  try {
    if (text) sessionStorage.setItem(SHARED_TEXT_KEY, text.slice(0, MAX_SHARED_CHARS));
    else sessionStorage.removeItem(SHARED_TEXT_KEY);
  } catch {
    // ignore
  }
}

/**
 * Turns a pasted WhatsApp message into clean item lines: drops "[3/11 10:15] Mamá:" headers,
 * bullets, numbering, checkboxes, emoji-only lines and links.
 */
export function cleanSharedListLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        // WhatsApp export header: "[3/11/26, 10:15] Mamá: ..." or "3/11/26 10:15 - Mamá: ..."
        .replace(/^\[?\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:[ap]\.?\s?m\.?)?\]?\s*(?:-\s*)?[^:]{1,40}:\s*/i, '')
        .replace(/https?:\/\/\S+/g, '')
        .replace(/^\s*(?:[-*•·▪◦‣–—✓✔☐☑✅⬜🔲]|\d{1,2}[.)])\s*/u, '')
        .replace(/\s+/g, ' ')
        .trim()
    )
    .filter((line) => /[\p{L}\d]/u.test(line))
    .filter((line) => !/^(lista( de (compras|super|súper))?|compras|súper|super)\s*:?$/i.test(line));
}

/** Groups clean lines into chunks the AI accepts (each at most MAX_SHOPPING_TEXT_CHARS). */
export function chunkSharedLines(lines: string[]): string[] {
  const chunks: string[] = [];
  let current = '';
  for (const raw of lines) {
    const line = raw.slice(0, MAX_SHOPPING_TEXT_CHARS - 10);
    const next = current ? `${current}, ${line}` : line;
    if (next.length > MAX_SHOPPING_TEXT_CHARS && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
