// Small helpers shared by the Edge Functions other than `assistant` (which keeps its own copy).
import { createClient, type SupabaseClient, type User } from "jsr:@supabase/supabase-js@2";

const LOCAL_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

export function isAllowedOrigin(origin: string): boolean {
  const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return configured.length > 0 ? configured.includes(origin) : LOCAL_ORIGIN.test(origin);
}

export function corsHeadersFor(origin: string): Record<string, string> {
  if (!origin) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

export function json(body: unknown, status: number, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

export function serviceClient(): SupabaseClient {
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not available");
  return createClient(Deno.env.get("SUPABASE_URL") ?? "", key, { auth: { persistSession: false } });
}

export async function userFromRequest(req: Request): Promise<{ user: User | null; userClient: SupabaseClient }> {
  const userClient = createClient(Deno.env.get("SUPABASE_URL") ?? "", Deno.env.get("SUPABASE_ANON_KEY") ?? "", {
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    auth: { persistSession: false },
  });
  const { data } = await userClient.auth.getUser();
  return { user: data?.user ?? null, userClient };
}

/** Constant-time comparison for the shared secret used by pg_cron calls. */
export function safeEqual(a: string, b: string): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Called from pg_cron with header `x-cron-secret` = secret CRON_SECRET. */
export function isCronRequest(req: Request): boolean {
  return safeEqual(req.headers.get("x-cron-secret") ?? "", Deno.env.get("CRON_SECRET") ?? "");
}

export function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function appUrl(path = "/"): string {
  const base = (Deno.env.get("APP_URL") ?? "").replace(/\/$/, "");
  return base ? `${base}${path}` : path;
}

export async function sendEmail(to: string[], subject: string, html: string, text: string): Promise<{ ok: boolean; detail?: string }> {
  const resendKey = Deno.env.get("RESEND_API_KEY");
  if (!resendKey) return { ok: false, detail: "RESEND_API_KEY missing" };
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    signal: AbortSignal.timeout(15_000),
    headers: { Authorization: `Bearer ${resendKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: Deno.env.get("REPORT_FROM") || "Canastica <onboarding@resend.dev>",
      to,
      subject: subject.slice(0, 200),
      html,
      text,
    }),
  }).catch((err) => err as Error);
  if (res instanceof Error) return { ok: false, detail: String(res) };
  if (!res.ok) return { ok: false, detail: `Resend ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}` };
  return { ok: true };
}
