// ============================================================================
// Web Push on this device: permission, subscription stored in Supabase and the
// per-user preferences for each kind of notice.
// Needs VITE_VAPID_PUBLIC_KEY (public half of the VAPID pair used by the `notify` function).
// ============================================================================

import type { SupabaseClient } from '@supabase/supabase-js';
import { getServiceWorkerRegistration, isIos, isStandalone } from './pwa';
import { devLog } from './devConsole';

export type NotificationKind = 'list_added' | 'price_alerts' | 'restock' | 'summary' | 'inbound_invoices';

export type NotificationPrefs = Record<NotificationKind, boolean>;

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  list_added: true,
  price_alerts: true,
  restock: true,
  summary: true,
  inbound_invoices: true,
};

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  list_added: 'Alguien agregó algo a la lista',
  price_alerts: 'Subidas de precio',
  restock: 'Productos por acabarse',
  summary: 'Resumen semanal o mensual',
  inbound_invoices: 'Facturas nuevas por correo',
};

export const NOTIFY_FUNCTION_NAME = 'notify';

const VAPID_PUBLIC_KEY = (import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined) ?? '';

export type PushSupport = 'supported' | 'needs-install' | 'unsupported' | 'not-configured';

export function pushSupport(): PushSupport {
  if (!VAPID_PUBLIC_KEY) return 'not-configured';
  if (!('serviceWorker' in navigator) || !('Notification' in window)) {
    // iPhone only exposes push to apps added to the home screen (iOS 16.4+)
    return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  }
  if (!('PushManager' in window)) return isIos() && !isStandalone() ? 'needs-install' : 'unsupported';
  return 'supported';
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export async function getCurrentSubscription(): Promise<PushSubscription | null> {
  const reg = await getServiceWorkerRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

/** Asks for permission (must run from a tap) and stores this device's subscription. */
export async function enablePush(sb: SupabaseClient, userId: string): Promise<'ok' | 'denied' | 'unavailable'> {
  if (pushSupport() !== 'supported') return 'unavailable';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const reg = await getServiceWorkerRegistration();
  if (!reg) return 'unavailable';
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY) }));
  const json = sub.toJSON();
  const { error } = await sb.from('push_subscriptions').upsert(
    {
      user_id: userId,
      endpoint: sub.endpoint,
      p256dh: json.keys?.p256dh ?? '',
      auth: json.keys?.auth ?? '',
      user_agent: navigator.userAgent.slice(0, 300),
    },
    { onConflict: 'endpoint' }
  );
  if (error) throw new Error(error.message);
  devLog('success', 'Push', 'Notificaciones activadas en este dispositivo');
  return 'ok';
}

export async function disablePush(sb: SupabaseClient): Promise<void> {
  const sub = await getCurrentSubscription();
  if (!sub) return;
  await sb.from('push_subscriptions').delete().eq('endpoint', sub.endpoint);
  await sub.unsubscribe().catch(() => undefined);
}

export async function loadNotificationPrefs(sb: SupabaseClient, userId: string): Promise<NotificationPrefs> {
  const { data } = await sb.from('notification_preferences').select('*').eq('user_id', userId).maybeSingle();
  if (!data) return { ...DEFAULT_NOTIFICATION_PREFS };
  const prefs = { ...DEFAULT_NOTIFICATION_PREFS };
  (Object.keys(prefs) as NotificationKind[]).forEach((k) => {
    if (typeof data[k] === 'boolean') prefs[k] = data[k];
  });
  return prefs;
}

export async function saveNotificationPrefs(sb: SupabaseClient, userId: string, prefs: NotificationPrefs): Promise<void> {
  const { error } = await sb
    .from('notification_preferences')
    .upsert({ user_id: userId, ...prefs, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
  if (error) throw new Error(error.message);
}

export async function sendTestPush(sb: SupabaseClient): Promise<number> {
  const { data, error } = await sb.functions.invoke(NOTIFY_FUNCTION_NAME, { body: { action: 'test' } });
  if (error) throw error;
  return Number(data?.sent ?? 0);
}

const LIST_NOTIFY_DELAY_MS = 20_000;
let pendingList: { sb: SupabaseClient; householdId: string; names: string[]; timer: number } | null = null;

function flushListNotice() {
  const p = pendingList;
  pendingList = null;
  if (!p || p.names.length === 0) return;
  void p.sb.functions
    .invoke(NOTIFY_FUNCTION_NAME, { body: { action: 'list-added', payload: { householdId: p.householdId, names: p.names } } })
    .catch(() => undefined);
}

/**
 * Tells the other members what was added to the list. Additions made within 20 s are
 * grouped into one notice so adding five products doesn't buzz everyone five times.
 */
export function notifyListAdded(sb: SupabaseClient, householdId: string, names: string[]): void {
  if (!VAPID_PUBLIC_KEY || names.length === 0) return;
  if (pendingList && pendingList.householdId !== householdId) {
    window.clearTimeout(pendingList.timer);
    flushListNotice();
  }
  if (pendingList) window.clearTimeout(pendingList.timer);
  pendingList = {
    sb,
    householdId,
    names: [...(pendingList?.names ?? []), ...names],
    timer: window.setTimeout(flushListNotice, LIST_NOTIFY_DELAY_MS),
  };
}
