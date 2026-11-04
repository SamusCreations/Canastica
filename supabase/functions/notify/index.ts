// ============================================================================
// Edge Function `notify`: Web Push notices triggered from the app.
//   action "test"        -> a test push to the caller's own devices
//   action "list-added"  -> tells the other members that the caller added products to the list
// Later features add more actions (price alerts). Requires a signed-in user.
// ============================================================================
import { corsHeadersFor, isAllowedOrigin, json, serviceClient, userFromRequest } from "../_shared/http.ts";
import { householdMemberIds, pushConfigured, sendPushToUsers } from "../_shared/push.ts";

const UUID = /^[0-9a-f-]{36}$/i;

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") ?? "";
  if (origin && !isAllowedOrigin(origin)) return json({ error: "forbidden" }, 403);
  const cors = corsHeadersFor(origin);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  const { user, userClient } = await userFromRequest(req);
  if (!user) return json({ error: "unauthorized" }, 401, cors);

  try {
    const body = await req.json().catch(() => null);
    const action = typeof body?.action === "string" ? body.action : "";
    const payload = (body?.payload ?? {}) as Record<string, unknown>;

    if (!pushConfigured()) return json({ sent: 0, configured: false }, 200, cors);
    const admin = serviceClient();

    if (action === "test") {
      const sent = await sendPushToUsers(admin, [user.id], "list_added", {
        title: "Canastica",
        body: "¡Listo! Las notificaciones funcionan en este dispositivo.",
        url: "/",
        tag: "test",
      });
      return json({ sent, configured: true }, 200, cors);
    }

    // Everything below acts on one household the caller must belong to (checked through RLS)
    const householdId = typeof payload.householdId === "string" ? payload.householdId : "";
    if (!UUID.test(householdId)) return json({ error: "bad_request" }, 400, cors);
    const { data: household } = await userClient.from("households").select("id, name").eq("id", householdId).maybeSingle();
    if (!household) return json({ error: "forbidden" }, 403, cors);

    const { data: profile } = await admin.from("profiles").select("full_name").eq("id", user.id).maybeSingle();
    const actor = (profile?.full_name || user.email?.split("@")[0] || "Alguien").split(" ")[0];

    if (action === "list-added") {
      const names = (Array.isArray(payload.names) ? payload.names : [])
        .filter((n): n is string => typeof n === "string")
        .map((n) => n.slice(0, 60))
        .slice(0, 30);
      if (names.length === 0) return json({ sent: 0 }, 200, cors);
      const shown = names.slice(0, 4).join(", ") + (names.length > 4 ? ` y ${names.length - 4} más` : "");
      const recipients = await householdMemberIds(admin, householdId, user.id);
      const sent = await sendPushToUsers(admin, recipients, "list_added", {
        title: `${actor} agregó a la lista`,
        body: shown,
        url: "/?tab=shopping-list",
        tag: `list-${householdId}`,
      });
      return json({ sent }, 200, cors);
    }

    return json({ error: "unknown_action" }, 400, cors);
  } catch (err) {
    console.error("notify:", err);
    return json({ error: "internal" }, 500, cors);
  }
});
