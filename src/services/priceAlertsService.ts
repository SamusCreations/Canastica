// Price alerts persistence (tables price_alerts and price_alert_mutes).
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PriceAlert } from '../lib/priceAlerts';
import { NOTIFY_FUNCTION_NAME } from '../lib/pushNotifications';

export interface PriceAlertState {
  alerts: PriceAlert[];
  mutes: string[];
}

function mapAlert(r: Record<string, unknown>): PriceAlert {
  return {
    id: r.id as string,
    purchaseId: (r.purchase_id as string | null) ?? undefined,
    canonicalName: r.canonical_name as string,
    productName: r.product_name as string,
    supermarket: r.supermarket as string,
    previousPrice: Number(r.previous_price),
    newPrice: Number(r.new_price),
    unitLabel: (r.unit_label as string) || 'unid',
    changePct: Number(r.change_pct),
    seen: Boolean(r.seen),
    createdAt: r.created_at as string,
  };
}

/** Never throws: if the tables aren't there yet the app simply shows no alerts. */
export async function loadPriceAlertState(sb: SupabaseClient, householdId: string): Promise<PriceAlertState> {
  const [alertsRes, mutesRes] = await Promise.all([
    sb.from('price_alerts').select('*').eq('household_id', householdId).order('created_at', { ascending: false }).limit(50),
    sb.from('price_alert_mutes').select('canonical_name').eq('household_id', householdId),
  ]);
  return {
    alerts: alertsRes.error ? [] : (alertsRes.data ?? []).map(mapAlert),
    mutes: mutesRes.error ? [] : (mutesRes.data ?? []).map((m) => String(m.canonical_name)),
  };
}

export async function insertPriceAlerts(sb: SupabaseClient, householdId: string, userId: string, alerts: PriceAlert[]): Promise<void> {
  if (alerts.length === 0) return;
  const { error } = await sb.from('price_alerts').insert(
    alerts.map((a) => ({
      id: a.id,
      household_id: householdId,
      purchase_id: a.purchaseId ?? null,
      canonical_name: a.canonicalName,
      product_name: a.productName,
      supermarket: a.supermarket,
      previous_price: a.previousPrice,
      new_price: a.newPrice,
      unit_label: a.unitLabel,
      change_pct: a.changePct,
      created_by: userId,
    }))
  );
  if (error) throw new Error(error.message);
}

export async function markPriceAlertsSeen(sb: SupabaseClient, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const { error } = await sb.from('price_alerts').update({ seen: true }).in('id', ids);
  if (error) throw new Error(error.message);
}

export async function mutePriceAlerts(sb: SupabaseClient, householdId: string, userId: string, canonicalName: string): Promise<void> {
  const { error } = await sb
    .from('price_alert_mutes')
    .upsert({ household_id: householdId, canonical_name: canonicalName.trim().toLowerCase(), muted_by: userId });
  if (error) throw new Error(error.message);
}

export async function unmutePriceAlerts(sb: SupabaseClient, householdId: string, canonicalName: string): Promise<void> {
  const { error } = await sb
    .from('price_alert_mutes')
    .delete()
    .eq('household_id', householdId)
    .eq('canonical_name', canonicalName.trim().toLowerCase());
  if (error) throw new Error(error.message);
}

/** Push to the other members (fire and forget). */
export function notifyPriceAlerts(sb: SupabaseClient, householdId: string, alerts: PriceAlert[]): void {
  if (alerts.length === 0) return;
  void sb.functions
    .invoke(NOTIFY_FUNCTION_NAME, {
      body: {
        action: 'price-alerts',
        payload: {
          householdId,
          alerts: alerts.slice(0, 10).map((a) => ({
            name: a.productName,
            store: a.supermarket,
            pct: a.changePct,
            from: a.previousPrice,
            to: a.newPrice,
            unit: a.unitLabel,
          })),
        },
      },
    })
    .catch(() => undefined);
}
