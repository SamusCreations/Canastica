// ============================================================================
// Edge Function `summary`: weekly / monthly household summary by email (Resend)
// and/or push, plus a daily "about to run out" push.
//
// Called by pg_cron (migration 20261103000004) with header x-cron-secret = CRON_SECRET:
//   { "period": "weekly" | "monthly" | "daily" }
// A signed-in member can also ask for a test of their own household:
//   { "action": "preview", "householdId": "...", "period": "weekly" | "monthly" }  -> sent only to the caller
// ============================================================================
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import {
  appUrl,
  corsHeadersFor,
  escapeHtml,
  isAllowedOrigin,
  isCronRequest,
  json,
  sendEmail,
  serviceClient,
  userFromRequest,
} from "../_shared/http.ts";
import { sendPushToUsers } from "../_shared/push.ts";

type Period = "weekly" | "monthly";

const CRC = new Intl.NumberFormat("es-CR", { style: "currency", currency: "CRC", maximumFractionDigits: 0 });
const fmt = (n: number) => CRC.format(Math.round(n));

const CATEGORY_ES: Record<string, string> = {
  "Dairy & Eggs": "Lácteos y huevos",
  "Meat & Poultry": "Carnes",
  Produce: "Frutas y verduras",
  Bakery: "Panadería",
  "Pantry Staples": "Abarrotes",
  Beverages: "Bebidas",
  Snacks: "Snacks",
  "Cleaning & Home": "Limpieza y hogar",
  "Personal Care": "Cuidado personal",
};

// ---------------------------------------------------------------------------
// Dates (Costa Rica, UTC-6 all year)
// ---------------------------------------------------------------------------

function crToday(): string {
  return new Date(Date.now() - 6 * 3600_000).toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** [start, end] inclusive of the period that just ended, and the one before it. */
function periodRange(period: Period, today = crToday()): { start: string; end: string; prevStart: string; prevEnd: string; label: string } {
  if (period === "weekly") {
    const end = addDays(today, -1);
    const start = addDays(today, -7);
    return { start, end, prevStart: addDays(start, -7), prevEnd: addDays(start, -1), label: "la semana pasada" };
  }
  const [y, m] = today.split("-").map(Number);
  const firstThis = new Date(Date.UTC(y, m - 1, 1));
  const firstPrev = new Date(Date.UTC(y, m - 2, 1));
  const firstPrevPrev = new Date(Date.UTC(y, m - 3, 1));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const monthName = firstPrev.toLocaleDateString("es-CR", { month: "long", timeZone: "UTC" });
  return {
    start: iso(firstPrev),
    end: addDays(iso(firstThis), -1),
    prevStart: iso(firstPrevPrev),
    prevEnd: addDays(iso(firstPrev), -1),
    label: monthName,
  };
}

// ---------------------------------------------------------------------------
// Summary data
// ---------------------------------------------------------------------------

interface HouseholdSummary {
  householdId: string;
  householdName: string;
  label: string;
  spent: number;
  previousSpent: number;
  budgetForPeriod: number;
  receipts: number;
  promoSavings: number;
  topCategories: { name: string; amount: number }[];
  topProducts: { name: string; amount: number }[];
  priceAlerts: { name: string; store: string; pct: number }[];
  restockSoon: string[];
  balances: { name: string; net: number }[];
}

type Row = Record<string, unknown>;
const n = (v: unknown) => Number(v) || 0;

async function buildSummary(admin: SupabaseClient, householdId: string, period: Period): Promise<HouseholdSummary | null> {
  const range = periodRange(period);
  const today = crToday();
  const monthStart = `${today.slice(0, 7)}-01`;

  const [{ data: hh }, { data: members }, { data: purchases }, { data: alerts }, { data: restock }, { data: settlements }, { data: listItems }] =
    await Promise.all([
      admin.from("households").select("id, name, monthly_budget, restock_alert_days").eq("id", householdId).maybeSingle(),
      admin.from("household_members").select("user_id, profiles(full_name)").eq("household_id", householdId),
      admin
        .from("purchases")
        .select("id, purchase_date, created_by, total_amount, discounts, purchase_items(normalized_name, canonical_name, category, total_price, is_shared, assigned_to)")
        .eq("household_id", householdId)
        .gte("purchase_date", range.prevStart < monthStart ? range.prevStart : monthStart),
      admin
        .from("price_alerts")
        .select("product_name, supermarket, change_pct, created_at")
        .eq("household_id", householdId)
        .gte("created_at", `${range.start}T06:00:00Z`)
        .order("change_pct", { ascending: false })
        .limit(5),
      admin.from("restock_predictions").select("canonical_name, estimated_days_remaining, updated_at").eq("household_id", householdId),
      admin.from("expense_settlements").select("from_member_id, to_member_id, amount").eq("household_id", householdId),
      admin.from("shopping_list_items").select("canonical_name, name").eq("household_id", householdId).eq("is_checked", false),
    ]);
  if (!hh) return null;

  const all = (purchases ?? []) as Row[];
  const inRange = (p: Row, s: string, e: string) => String(p.purchase_date) >= s && String(p.purchase_date) <= e;
  const current = all.filter((p) => inRange(p, range.start, range.end));
  const previous = all.filter((p) => inRange(p, range.prevStart, range.prevEnd));

  const spent = current.reduce((s, p) => s + n(p.total_amount), 0);
  const previousSpent = previous.reduce((s, p) => s + n(p.total_amount), 0);
  const promoSavings = current.reduce((s, p) => s + Math.abs(n(p.discounts)), 0);

  const byCategory = new Map<string, number>();
  const byProduct = new Map<string, number>();
  for (const p of current) {
    for (const it of (p.purchase_items as Row[]) ?? []) {
      const cat = CATEGORY_ES[String(it.category)] ?? String(it.category);
      byCategory.set(cat, (byCategory.get(cat) ?? 0) + n(it.total_price));
      const prod = String(it.canonical_name || it.normalized_name || "");
      if (prod) byProduct.set(prod, (byProduct.get(prod) ?? 0) + n(it.total_price));
    }
  }
  const top = (m: Map<string, number>, k: number) =>
    [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([name, amount]) => ({ name, amount }));

  // About to run out (and not already on the list)
  const onList = new Set(((listItems ?? []) as Row[]).flatMap((i) => [String(i.canonical_name ?? "").toLowerCase(), String(i.name ?? "").toLowerCase()]));
  const alertDays = n(hh.restock_alert_days) || 2;
  const restockSoon = ((restock ?? []) as Row[])
    .map((r) => {
      const ageDays = (Date.now() - new Date(String(r.updated_at)).getTime()) / 86_400_000;
      return { name: String(r.canonical_name), left: n(r.estimated_days_remaining) - ageDays };
    })
    .filter((r) => r.left <= alertDays + 5 && !onList.has(r.name.toLowerCase()))
    .sort((a, b) => a.left - b.left)
    .slice(0, 6)
    .map((r) => r.name);

  // Balances: same rule as the app (this month's purchases, all settlements)
  const memberRows = (members ?? []) as Row[];
  const ids = memberRows.map((m) => String(m.user_id));
  const nameOf = (id: string) => {
    const row = memberRows.find((m) => m.user_id === id);
    const profile = row?.profiles as Row | undefined;
    return String(profile?.full_name ?? "Alguien").split(" ")[0];
  };
  const paid = new Map(ids.map((id) => [id, 0]));
  const personal = new Map(ids.map((id) => [id, 0]));
  let sharedPool = 0;
  for (const p of all.filter((x) => String(x.purchase_date) >= monthStart)) {
    const payer = String(p.created_by);
    paid.set(payer, (paid.get(payer) ?? 0) + n(p.total_amount));
    const items = (p.purchase_items as Row[]) ?? [];
    const itemsSum = items.reduce((s, i) => s + n(i.total_price), 0);
    const scale = itemsSum > 0 ? n(p.total_amount) / itemsSum : 1;
    for (const it of items) {
      const cost = n(it.total_price) * scale;
      if (it.is_shared) sharedPool += cost;
      else {
        const owner = it.assigned_to && personal.has(String(it.assigned_to)) ? String(it.assigned_to) : payer;
        personal.set(owner, (personal.get(owner) ?? 0) + cost);
      }
    }
  }
  const share = sharedPool / Math.max(1, ids.length);
  const balances = ids
    .map((id) => {
      let net = (paid.get(id) ?? 0) - share - (personal.get(id) ?? 0);
      for (const s of (settlements ?? []) as Row[]) {
        if (s.from_member_id === id) net += n(s.amount);
        if (s.to_member_id === id) net -= n(s.amount);
      }
      return { name: nameOf(id), net: Math.round(net) };
    })
    .filter((b) => Math.abs(b.net) > 100);

  const budget = n(hh.monthly_budget);
  return {
    householdId,
    householdName: String(hh.name),
    label: range.label,
    spent,
    previousSpent,
    budgetForPeriod: period === "weekly" ? (budget * 7) / 30.4 : budget,
    receipts: current.length,
    promoSavings,
    topCategories: top(byCategory, 3),
    topProducts: top(byProduct, 5),
    priceAlerts: ((alerts ?? []) as Row[]).map((a) => ({ name: String(a.product_name), store: String(a.supermarket), pct: Math.round(n(a.change_pct)) })),
    restockSoon,
    balances,
  };
}

function changeText(current: number, previous: number): string {
  if (previous <= 0) return "";
  const pct = Math.round(((current - previous) / previous) * 100);
  if (pct === 0) return "igual que el período anterior";
  return pct > 0 ? `${pct} % más que el período anterior` : `${Math.abs(pct)} % menos que el período anterior`;
}

function renderEmail(s: HouseholdSummary): { subject: string; html: string; text: string } {
  const change = changeText(s.spent, s.previousSpent);
  const budgetLine =
    s.budgetForPeriod > 0
      ? s.spent <= s.budgetForPeriod
        ? `Vas ${fmt(s.budgetForPeriod - s.spent)} por debajo del presupuesto.`
        : `Te pasaste ${fmt(s.spent - s.budgetForPeriod)} del presupuesto.`
      : "";
  const section = (title: string, items: string[]) =>
    items.length
      ? `<h3 style="margin:18px 0 6px;font-size:15px;color:#4f7f27">${escapeHtml(title)}</h3><ul style="margin:0;padding-left:18px">${items
          .map((i) => `<li>${i}</li>`)
          .join("")}</ul>`
      : "";
  const html = `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111;max-width:560px">
<h2 style="margin:0 0 4px;color:#4f7f27">Resumen de ${escapeHtml(s.label)}</h2>
<p style="margin:0 0 12px;color:#555">${escapeHtml(s.householdName)}</p>
<p style="font-size:22px;margin:0"><strong>${escapeHtml(fmt(s.spent))}</strong> en ${s.receipts} ${s.receipts === 1 ? "compra" : "compras"}</p>
${change ? `<p style="margin:4px 0;color:#555">${escapeHtml(change)}</p>` : ""}
${budgetLine ? `<p style="margin:4px 0">${escapeHtml(budgetLine)}</p>` : ""}
${s.promoSavings > 0 ? `<p style="margin:4px 0">Ahorraste ${escapeHtml(fmt(s.promoSavings))} en promociones.</p>` : ""}
${section("Dónde se fue la plata", s.topCategories.map((c) => `${escapeHtml(c.name)}: ${escapeHtml(fmt(c.amount))}`))}
${section("Productos con más gasto", s.topProducts.map((c) => `${escapeHtml(c.name)}: ${escapeHtml(fmt(c.amount))}`))}
${section("Subidas de precio", s.priceAlerts.map((a) => `${escapeHtml(a.name)} +${a.pct} % en ${escapeHtml(a.store)}`))}
${section("Por reponer pronto", s.restockSoon.map(escapeHtml))}
${section("Saldos pendientes", s.balances.map((b) => (b.net > 0 ? `A ${escapeHtml(b.name)} le deben ${escapeHtml(fmt(b.net))}` : `${escapeHtml(b.name)} debe ${escapeHtml(fmt(-b.net))}`)))}
<p style="margin-top:22px"><a href="${escapeHtml(appUrl("/"))}" style="color:#4f7f27;font-weight:bold">Abrir Canastica</a></p>
<p style="color:#888;font-size:12px">Puedes cambiar o apagar este resumen en Canastica: Cuenta › Resumen.</p>
</div>`;
  const text = [
    `Resumen de ${s.label} · ${s.householdName}`,
    `${fmt(s.spent)} en ${s.receipts} compras${change ? ` (${change})` : ""}.`,
    budgetLine,
    s.promoSavings > 0 ? `Ahorraste ${fmt(s.promoSavings)} en promociones.` : "",
    s.topCategories.length ? `Categorías: ${s.topCategories.map((c) => `${c.name} ${fmt(c.amount)}`).join(", ")}` : "",
    s.priceAlerts.length ? `Subidas: ${s.priceAlerts.map((a) => `${a.name} +${a.pct} %`).join(", ")}` : "",
    s.restockSoon.length ? `Por reponer: ${s.restockSoon.join(", ")}` : "",
    appUrl("/"),
  ]
    .filter(Boolean)
    .join("\n");
  return { subject: `[Canastica] Resumen de ${s.label}: ${fmt(s.spent)}`, html, text };
}

function pushBody(s: HouseholdSummary): string {
  const change = changeText(s.spent, s.previousSpent);
  return [`${fmt(s.spent)} en ${s.label}${change ? `, ${change}` : ""}.`, s.restockSoon.length ? `Por reponer: ${s.restockSoon.slice(0, 3).join(", ")}.` : ""]
    .filter(Boolean)
    .join(" ");
}

interface Recipient {
  userId: string;
  email: string | null;
  wantsEmail: boolean;
}

async function deliver(admin: SupabaseClient, summary: HouseholdSummary, recipients: Recipient[]): Promise<{ emails: number; pushes: number }> {
  let emails = 0;
  const mail = renderEmail(summary);
  for (const r of recipients) {
    if (r.wantsEmail && r.email) {
      const res = await sendEmail([r.email], mail.subject, mail.html, mail.text);
      if (res.ok) emails += 1;
      else console.error("summary email failed", r.userId, res.detail);
    }
  }
  const pushes = await sendPushToUsers(
    admin,
    recipients.map((r) => r.userId),
    "summary",
    { title: `Resumen de ${summary.label}`, body: pushBody(summary), url: "/?tab=analytics", tag: `summary-${summary.householdId}` }
  );
  return { emails, pushes };
}

async function runPeriodic(admin: SupabaseClient, period: Period) {
  const { data: memberships } = await admin.from("household_members").select("household_id, user_id, profiles(email)");
  const { data: prefs } = await admin.from("notification_preferences").select("user_id, summary_frequency, summary_email");
  const prefOf = new Map(((prefs ?? []) as Row[]).map((p) => [String(p.user_id), p]));

  const byHousehold = new Map<string, Recipient[]>();
  for (const m of (memberships ?? []) as Row[]) {
    const p = prefOf.get(String(m.user_id));
    const frequency = String(p?.summary_frequency ?? "weekly");
    if (frequency !== period) continue;
    const list = byHousehold.get(String(m.household_id)) ?? [];
    list.push({
      userId: String(m.user_id),
      email: ((m.profiles as Row | undefined)?.email as string | undefined) ?? null,
      wantsEmail: Boolean(p?.summary_email),
    });
    byHousehold.set(String(m.household_id), list);
  }

  let households = 0;
  let emails = 0;
  let pushes = 0;
  for (const [householdId, recipients] of byHousehold) {
    const summary = await buildSummary(admin, householdId, period);
    if (!summary || (summary.receipts === 0 && summary.restockSoon.length === 0)) continue;
    const res = await deliver(admin, summary, recipients);
    households += 1;
    emails += res.emails;
    pushes += res.pushes;
  }
  return { households, emails, pushes };
}

/** Daily push: products about to run out that aren't on the list yet. */
async function runDaily(admin: SupabaseClient) {
  const { data: households } = await admin.from("households").select("id, restock_alert_days");
  let pushes = 0;
  for (const hh of (households ?? []) as Row[]) {
    const [{ data: restock }, { data: listItems }, { data: members }] = await Promise.all([
      admin.from("restock_predictions").select("canonical_name, estimated_days_remaining, updated_at").eq("household_id", hh.id),
      admin.from("shopping_list_items").select("canonical_name, name").eq("household_id", hh.id).eq("is_checked", false),
      admin.from("household_members").select("user_id").eq("household_id", hh.id),
    ]);
    const onList = new Set(((listItems ?? []) as Row[]).flatMap((i) => [String(i.canonical_name ?? "").toLowerCase(), String(i.name ?? "").toLowerCase()]));
    const alertDays = n(hh.restock_alert_days) || 2;
    const soon = ((restock ?? []) as Row[])
      .map((r) => ({
        name: String(r.canonical_name),
        left: n(r.estimated_days_remaining) - (Date.now() - new Date(String(r.updated_at)).getTime()) / 86_400_000,
      }))
      // Only the day it enters the alert window, so nobody gets the same notice every morning
      .filter((r) => r.left <= alertDays && r.left > alertDays - 1 && !onList.has(r.name.toLowerCase()))
      .map((r) => r.name);
    if (soon.length === 0) continue;
    pushes += await sendPushToUsers(
      admin,
      ((members ?? []) as Row[]).map((m) => String(m.user_id)),
      "restock",
      {
        title: soon.length === 1 ? `Pronto se acaba: ${soon[0]}` : `Pronto se acaban ${soon.length} productos`,
        body: soon.slice(0, 5).join(", "),
        url: "/?tab=restock-ai",
        tag: `restock-${hh.id}`,
      }
    );
  }
  return { pushes };
}

Deno.serve(async (req: Request) => {
  const origin = req.headers.get("Origin") ?? "";
  if (origin && !isAllowedOrigin(origin)) return json({ error: "forbidden" }, 403);
  const cors = corsHeadersFor(origin);
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });

  try {
    const body = (await req.json().catch(() => ({}))) as Row;
    const admin = serviceClient();

    if (isCronRequest(req)) {
      if (body.period === "daily") return json(await runDaily(admin), 200);
      if (body.period === "weekly" || body.period === "monthly") return json(await runPeriodic(admin, body.period), 200);
      return json({ error: "bad_request" }, 400);
    }

    // Test from the app: the caller's own household, sent only to the caller
    const { user, userClient } = await userFromRequest(req);
    if (!user) return json({ error: "unauthorized" }, 401, cors);
    if (body.action !== "preview") return json({ error: "unknown_action" }, 400, cors);
    const householdId = typeof body.householdId === "string" ? body.householdId : "";
    const { data: member } = await userClient.from("households").select("id").eq("id", householdId).maybeSingle();
    if (!member) return json({ error: "forbidden" }, 403, cors);
    const period: Period = body.period === "monthly" ? "monthly" : "weekly";
    const summary = await buildSummary(admin, householdId, period);
    if (!summary) return json({ error: "not_found" }, 404, cors);
    const result = await deliver(admin, summary, [{ userId: user.id, email: user.email ?? null, wantsEmail: true }]);
    return json({ ...result, summary }, 200, cors);
  } catch (err) {
    console.error("summary:", err);
    return json({ error: "internal" }, 500, cors);
  }
});
