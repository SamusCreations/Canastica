// ============================================================================
// What the user is looking at and the latest app errors, for problem reports.
// In memory only; error messages are trimmed and never include tokens or keys.
// ============================================================================

export interface ReportScreenContext {
  screen?: string | null;
  openPanel?: string | null;
  householdId?: string | null;
  userName?: string | null;
  language?: string | null;
}

export interface AppErrorEntry {
  time: string;
  source: string;
  message: string;
}

const MAX_ERRORS = 15;
let screenContext: ReportScreenContext = {};
let recentErrors: AppErrorEntry[] = [];

export function setReportScreenContext(next: ReportScreenContext): void {
  screenContext = { ...screenContext, ...next };
}

export function getReportScreenContext(): ReportScreenContext {
  return screenContext;
}

// Long tokens (JWTs, API keys) and e-mail addresses are masked before keeping a message
function scrub(message: string): string {
  return message
    .replace(/eyJ[\w-]{10,}\.[\w-]+\.[\w-]+/g, '[token]')
    .replace(/\b(sb_[a-z]+_|sk-|AIza)[\w-]{8,}/g, '[clave]')
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[correo]')
    .slice(0, 300);
}

export function recordAppError(source: string, message: unknown): void {
  const text = message instanceof Error ? message.message : String(message ?? '');
  if (!text) return;
  recentErrors = [{ time: new Date().toISOString(), source, message: scrub(text) }, ...recentErrors].slice(
    0,
    MAX_ERRORS
  );
}

export function getRecentErrors(): AppErrorEntry[] {
  return recentErrors;
}

/** Captures uncaught errors and rejected promises once, at start-up. */
export function installGlobalErrorCapture(): void {
  window.addEventListener('error', (e) => recordAppError('ventana', e.message || e.error));
  window.addEventListener('unhandledrejection', (e) => recordAppError('promesa', e.reason));
}
