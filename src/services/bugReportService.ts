// ============================================================================
// "Reportar un problema": builds the technical context and sends the report
// to the server, which stores it and emails it to the admin.
// ============================================================================

import { FunctionsHttpError } from '@supabase/supabase-js';
import { getRecentErrors, getReportScreenContext } from '../lib/appContext';
import { devLog, getDevLog, isDeveloperMode } from '../lib/devConsole';
import { AI_FUNCTION_NAME, getAiQuota, getSupabaseClient, shrinkImageDataUrl } from './geminiAndSupabaseService';

function deviceSummary(ua: string): string {
  const os = /iPhone|iPad|iPod/.test(ua)
    ? 'iOS'
    : /Android/.test(ua)
    ? 'Android'
    : /Windows/.test(ua)
    ? 'Windows'
    : /Mac OS X/.test(ua)
    ? 'macOS'
    : /Linux/.test(ua)
    ? 'Linux'
    : 'Otro';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /SamsungBrowser/.test(ua)
    ? 'Samsung Internet'
    : /CriOS|Chrome\//.test(ua)
    ? 'Chrome'
    : /FxiOS|Firefox\//.test(ua)
    ? 'Firefox'
    : /Safari\//.test(ua)
    ? 'Safari'
    : 'Otro';
  return `${browser} en ${os}`;
}

/** Device, screen and app details. No tokens, keys, receipt contents or other members' data. */
export function buildReportContext(): Record<string, unknown> {
  const screenCtx = getReportScreenContext();
  const ua = navigator.userAgent;
  const url = new URL(window.location.href);
  url.searchParams.delete('join'); // invite codes stay out of reports
  const now = new Date();
  return {
    screen: screenCtx.screen ?? null,
    openPanel: screenCtx.openPanel ?? null,
    householdId: screenCtx.householdId ?? null,
    url: `${url.origin}${url.pathname}${url.search}`,
    localTime: now.toLocaleString(),
    clientTime: now.toISOString(),
    device: {
      summary: deviceSummary(ua),
      userAgent: ua,
      platform:
        (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
        navigator.platform,
      mobile: /Mobi|Android|iPhone|iPad/.test(ua),
      touch: navigator.maxTouchPoints > 0,
      screen: `${window.screen.width}×${window.screen.height}`,
      viewport: `${window.innerWidth}×${window.innerHeight}`,
      pixelRatio: window.devicePixelRatio,
      orientation: window.screen.orientation?.type ?? (window.innerWidth > window.innerHeight ? 'landscape' : 'portrait'),
      language: navigator.language,
      timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      theme: document.documentElement.classList.contains('dark') ? 'oscuro' : 'claro',
      online: navigator.onLine,
      standalone: window.matchMedia('(display-mode: standalone)').matches,
    },
    app: { version: __APP_VERSION__, buildTime: __BUILD_TIME__ },
    aiQuota: getAiQuota(),
    recentErrors: getRecentErrors(),
    // Only developer accounts attach their console (the server drops it for everyone else)
    ...(isDeveloperMode() ? { devLog: getDevLog().slice(0, 50) } : {}),
  };
}

export type SendReportResult = { ok: true; reportId: string } | { ok: false; message: string };

export async function sendProblemReport(description: string, imageDataUrl: string | null): Promise<SendReportResult> {
  const client = getSupabaseClient();
  if (!client) return { ok: false, message: 'El servicio no está disponible en este momento.' };

  let imageBase64: string | null = null;
  if (imageDataUrl) {
    const small = await shrinkImageDataUrl(imageDataUrl, 1600, 0.8);
    imageBase64 = small.split(',')[1] ?? null;
  }

  const started = performance.now();
  const { data, error } = await client.functions.invoke(AI_FUNCTION_NAME, {
    body: {
      action: 'report-bug',
      payload: {
        description: description.trim(),
        imageBase64,
        imageType: 'image/jpeg',
        context: buildReportContext(),
      },
    },
  });

  if (error) {
    let body: { code?: string; error?: string } | null = null;
    if (error instanceof FunctionsHttpError) {
      body = await (error.context as Response).json().catch(() => null);
    }
    devLog('error', 'Reporte', `No se pudo enviar: ${body?.code ?? error.name}`, {
      durationMs: Math.round(performance.now() - started),
      detail: body ?? error.message,
    });
    if (body?.code === 'REPORT_LIMIT') return { ok: false, message: body.error ?? 'Ya enviaste varios reportes hoy.' };
    if (body?.code === 'too_large') return { ok: false, message: 'La imagen es demasiado grande. Prueba con otra.' };
    return {
      ok: false,
      message: navigator.onLine
        ? 'No se pudo enviar el reporte. Inténtalo de nuevo en unos minutos.'
        : 'Sin conexión a internet. Revisa tu conexión e inténtalo de nuevo.',
    };
  }

  devLog('success', 'Reporte', `Enviado (${data?.reportId})`, {
    durationMs: Math.round(performance.now() - started),
    detail: data?.debug,
  });
  return { ok: true, reportId: String(data?.reportId ?? '') };
}

export interface BugReportRow {
  id: string;
  created_at: string;
  user_email: string | null;
  household_id: string | null;
  description: string;
  screen: string | null;
  context: Record<string, unknown>;
  email_status: string;
  screenshotUrl: string | null;
}

/** Developer console only: the server refuses it for everyone else. */
export async function listBugReports(): Promise<BugReportRow[]> {
  const client = getSupabaseClient();
  if (!client) return [];
  const { data, error } = await client.functions.invoke(AI_FUNCTION_NAME, { body: { action: 'list-bug-reports' } });
  if (error) {
    devLog('error', 'Reportes', 'No se pudieron cargar los reportes', { detail: error.message });
    return [];
  }
  return (data?.reports ?? []) as BugReportRow[];
}

