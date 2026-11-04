// Web Push sender (VAPID). Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT (mailto:...).
// Generate the key pair once with: npx web-push generate-vapid-keys
import webpush from "npm:web-push@3.6.7";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

export type PushKind = "list_added" | "price_alerts" | "restock" | "summary" | "inbound_invoices";

export interface PushMessage {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}

let configured: boolean | null = null;

export function pushConfigured(): boolean {
  if (configured !== null) return configured;
  const pub = Deno.env.get("VAPID_PUBLIC_KEY");
  const priv = Deno.env.get("VAPID_PRIVATE_KEY");
  if (!pub || !priv) return (configured = false);
  webpush.setVapidDetails(Deno.env.get("VAPID_SUBJECT") || "mailto:soporte@canastica.app", pub, priv);
  return (configured = true);
}

/**
 * Sends a push to every device of the given users that kept this kind of notice on.
 * Dead subscriptions (404/410) are deleted. Returns how many pushes went out.
 */
export async function sendPushToUsers(
  admin: SupabaseClient,
  userIds: string[],
  kind: PushKind,
  message: PushMessage
): Promise<number> {
  const unique = [...new Set(userIds)].filter(Boolean);
  if (unique.length === 0 || !pushConfigured()) return 0;

  const { data: prefs } = await admin.from("notification_preferences").select(`user_id, ${kind}`).in("user_id", unique);
  const optedOut = new Set(
    (prefs ?? []).filter((p: Record<string, unknown>) => p[kind] === false).map((p: Record<string, unknown>) => p.user_id as string)
  );
  const targets = unique.filter((id) => !optedOut.has(id));
  if (targets.length === 0) return 0;

  const { data: subs } = await admin
    .from("push_subscriptions")
    .select("id, endpoint, p256dh, auth")
    .in("user_id", targets);
  if (!subs?.length) return 0;

  const payload = JSON.stringify(message);
  let sent = 0;
  const dead: string[] = [];
  const used: string[] = [];
  await Promise.all(
    subs.map(async (s) => {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          payload,
          { TTL: 60 * 60 * 24, urgency: "normal" }
        );
        sent += 1;
        used.push(s.id);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (status === 404 || status === 410) dead.push(s.id);
        else console.error("push send failed", status, String(err).slice(0, 200));
      }
    })
  );
  if (dead.length) await admin.from("push_subscriptions").delete().in("id", dead);
  if (used.length) await admin.from("push_subscriptions").update({ last_used_at: new Date().toISOString() }).in("id", used);
  return sent;
}

/** Ids of the household's members, optionally without one of them (usually the person who acted). */
export async function householdMemberIds(admin: SupabaseClient, householdId: string, exceptUserId?: string): Promise<string[]> {
  const { data } = await admin.from("household_members").select("user_id").eq("household_id", householdId);
  return (data ?? []).map((m) => m.user_id as string).filter((id) => id !== exceptUserId);
}
