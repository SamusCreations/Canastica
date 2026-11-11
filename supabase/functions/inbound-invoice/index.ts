// ============================================================================
// Edge Function `inbound-invoice`: webhook for Resend Inbound ("email.received").
// Users forward their electronic invoices to facturas+<code>@<INBOUND_DOMAIN>; the code
// after "+" identifies the household. The XML (and PDF, if any) is stored in the private
// bucket `inbound-invoices` and a row goes to inbound_invoices for review in the app.
//
// Secrets: RESEND_API_KEY, RESEND_INBOUND_WEBHOOK_SECRET (whsec_...), optional
// INBOUND_REQUIRE_PLAN=true (only households with plan 'plus'), INBOUND_DAILY_LIMIT (default 40),
// INBOUND_DOMAIN (e.g. facturas.canastica.app in prod, facturas-staging.canastica.app in staging).
// Resend sends every email.received event of the account to every webhook, so with prod and
// staging on one Resend account each project also gets the other's emails. INBOUND_DOMAIN makes
// each project drop mail addressed to another domain before reading the database or downloading
// anything, and nothing about that mail (sender, subject, address) is logged or stored.
// Deploy with --no-verify-jwt: Resend doesn't send a Supabase JWT; the Svix signature is checked here.
// pg_cron also calls it with x-cron-secret and {"action":"cleanup"} to delete old attachments.
// ============================================================================
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";
import { isCronRequest, json, serviceClient } from "../_shared/http.ts";
import { householdMemberIds, sendPushToUsers } from "../_shared/push.ts";

const BUCKET = "inbound-invoices";
const MAX_ATTACHMENT_BYTES = 5_000_000;
const RETENTION_DAYS = 90;

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Svix signature (Resend webhooks)
// ---------------------------------------------------------------------------

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function verifySvix(req: Request, body: string): Promise<boolean> {
  const secret = Deno.env.get("RESEND_INBOUND_WEBHOOK_SECRET") ?? "";
  const id = req.headers.get("svix-id") ?? "";
  const timestamp = req.headers.get("svix-timestamp") ?? "";
  const signatures = req.headers.get("svix-signature") ?? "";
  if (!secret || !id || !timestamp || !signatures) return false;
  // Reject replays older than 5 minutes
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    base64ToBytes(secret.replace(/^whsec_/, "")),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
  const expected = btoa(String.fromCharCode(...mac));
  return signatures.split(" ").some((part) => {
    const [, sig] = part.split(",");
    if (!sig || sig.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < sig.length; i++) diff |= sig.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  });
}

// ---------------------------------------------------------------------------
// Hacienda XML (read with regex: no DOM in the Edge runtime; the app parses it fully)
// ---------------------------------------------------------------------------

const INVOICE_ROOT = /<(?:\w+:)?(FacturaElectronica|TiqueteElectronico|NotaCreditoElectronica|NotaDebitoElectronica|FacturaElectronicaCompra)[\s>]/;

function tag(xml: string, name: string): string {
  const m = xml.match(new RegExp(`<(?:\\w+:)?${name}>([^<]*)</(?:\\w+:)?${name}>`));
  return m ? m[1].trim() : "";
}

function readInvoiceXml(xml: string): { clave: string; issuer: string; total: number; issuedAt: string | null } | null {
  if (!INVOICE_ROOT.test(xml)) return null; // e.g. Hacienda's MensajeHacienda response, not the invoice
  const clave = tag(xml, "Clave");
  if (!/^\d{50}$/.test(clave)) return null;
  const emisor = xml.match(/<(?:\w+:)?Emisor>([\s\S]*?)<\/(?:\w+:)?Emisor>/)?.[1] ?? "";
  const issuer = tag(emisor, "NombreComercial") || tag(emisor, "Nombre");
  const total = Number(tag(xml, "TotalComprobante").replace(",", ".")) || 0;
  const issued = tag(xml, "FechaEmision").slice(0, 10);
  return { clave, issuer: issuer.slice(0, 120), total, issuedAt: /^\d{4}-\d{2}-\d{2}$/.test(issued) ? issued : null };
}

// ---------------------------------------------------------------------------
// Resend Inbound API
// ---------------------------------------------------------------------------

interface InboundAttachment {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

async function resendGet(path: string): Promise<Row | null> {
  const res = await fetch(`https://api.resend.com${path}`, {
    headers: { Authorization: `Bearer ${Deno.env.get("RESEND_API_KEY") ?? ""}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.error("resend", path, res.status, (await res.text().catch(() => "")).slice(0, 200));
    return null;
  }
  return (await res.json()) as Row;
}

async function fetchAttachments(emailId: string): Promise<InboundAttachment[]> {
  const list = await resendGet(`/emails/receiving/${encodeURIComponent(emailId)}/attachments`);
  const items = (Array.isArray(list?.data) ? list?.data : []) as Row[];
  const out: InboundAttachment[] = [];
  for (const a of items) {
    const filename = String(a.filename ?? "adjunto");
    const contentType = String(a.content_type ?? "");
    const wanted = /\.(xml|pdf)$/i.test(filename) || /xml|pdf/i.test(contentType);
    if (!wanted || Number(a.size ?? 0) > MAX_ATTACHMENT_BYTES || typeof a.download_url !== "string") continue;
    const res = await fetch(a.download_url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length <= MAX_ATTACHMENT_BYTES) out.push({ filename, contentType, bytes });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Handling
// ---------------------------------------------------------------------------

/** This project's receiving domain; empty = accept any domain (single-environment setups). */
function inboundDomain(): string {
  return (Deno.env.get("INBOUND_DOMAIN") ?? "").trim().toLowerCase().replace(/^@/, "");
}

function extractCode(addresses: string[], domain: string): string | null {
  for (const raw of addresses) {
    const address = (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase();
    const m = address.match(/^[^@+]+\+([a-z0-9]{8,16})@(.+)$/);
    if (m && (!domain || m[2] === domain)) return m[1];
  }
  return null;
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

async function handleEmail(admin: SupabaseClient, data: Row): Promise<Response> {
  // Only addresses on this project's domain count; mail for the other environment is dropped
  // here, before any lookup or download, and without logging anything about it.
  const code = extractCode([...asList(data.to), ...asList(data.cc), ...asList(data.bcc)], inboundDomain());
  if (!code) return json({ ignored: "no_code_for_this_domain" }, 200);

  const { data: mailbox } = await admin
    .from("invoice_mailboxes")
    .select("household_id, is_active, households(plan)")
    .eq("code", code)
    .maybeSingle();
  if (!mailbox || !mailbox.is_active) return json({ ignored: "unknown_mailbox" }, 200);
  const householdId = String(mailbox.household_id);
  const plan = String((mailbox.households as Row | null)?.plan ?? "free");
  if (Deno.env.get("INBOUND_REQUIRE_PLAN") === "true" && plan === "free") return json({ ignored: "plan" }, 200);

  const limit = Number(Deno.env.get("INBOUND_DAILY_LIMIT") ?? 40) || 40;
  const { count } = await admin
    .from("inbound_invoices")
    .select("id", { count: "exact", head: true })
    .eq("household_id", householdId)
    .gte("received_at", new Date(Date.now() - 86_400_000).toISOString());
  if ((count ?? 0) >= limit) return json({ ignored: "daily_limit" }, 200);

  const sender = String(data.from ?? "").slice(0, 200);
  const subject = String(data.subject ?? "").slice(0, 300);

  // Gmail asks to confirm the forwarding address: keep the code so the app can show it
  if (/forwarding-noreply@google\.com/i.test(sender)) {
    const confirmation = subject.match(/\(#(\d{6,12})\)/)?.[1] ?? null;
    await admin.from("inbound_invoices").insert({
      household_id: householdId,
      sender,
      subject,
      status: "confirmation",
      confirmation_code: confirmation,
      processed_at: new Date().toISOString(),
    });
    return json({ ok: "confirmation" }, 200);
  }

  const attachments = data.email_id ? await fetchAttachments(String(data.email_id)) : [];
  const decoder = new TextDecoder();
  let invoice: ReturnType<typeof readInvoiceXml> = null;
  let xmlAttachment: InboundAttachment | null = null;
  for (const a of attachments.filter((x) => /\.xml$/i.test(x.filename) || /xml/i.test(x.contentType))) {
    const parsed = readInvoiceXml(decoder.decode(a.bytes));
    if (parsed) {
      invoice = parsed;
      xmlAttachment = a;
      break;
    }
  }
  const pdf = attachments.find((x) => /\.pdf$/i.test(x.filename) || /pdf/i.test(x.contentType)) ?? null;

  const id = crypto.randomUUID();
  // Only real Hacienda invoices are accepted (a PDF alone is kept for manual review)
  if (!invoice && !pdf) {
    await admin.from("inbound_invoices").insert({
      id,
      household_id: householdId,
      sender,
      subject,
      status: "error",
      error_detail: "Sin XML de factura electrónica ni PDF",
      processed_at: new Date().toISOString(),
    });
    return json({ ok: "no_invoice" }, 200);
  }

  let status: "pending" | "duplicate" = "pending";
  if (invoice) {
    const { data: existing } = await admin
      .from("inbound_invoices")
      .select("id")
      .eq("household_id", householdId)
      .eq("clave", invoice.clave)
      .neq("status", "duplicate")
      .limit(1);
    if (existing && existing.length > 0) status = "duplicate";
  }

  let xmlPath: string | null = null;
  let pdfPath: string | null = null;
  if (status === "pending") {
    if (xmlAttachment) {
      xmlPath = `${householdId}/${id}.xml`;
      const { error } = await admin.storage.from(BUCKET).upload(xmlPath, xmlAttachment.bytes, { contentType: "application/xml" });
      if (error) xmlPath = null;
    }
    if (pdf) {
      pdfPath = `${householdId}/${id}.pdf`;
      const { error } = await admin.storage.from(BUCKET).upload(pdfPath, pdf.bytes, { contentType: "application/pdf" });
      if (error) pdfPath = null;
    }
  }

  const { error: insertError } = await admin.from("inbound_invoices").insert({
    id,
    household_id: householdId,
    sender,
    subject,
    clave: invoice?.clave ?? null,
    issuer: invoice?.issuer ?? null,
    total: invoice?.total ?? null,
    issued_at: invoice?.issuedAt ?? null,
    status,
    xml_path: xmlPath,
    pdf_path: pdfPath,
  });
  if (insertError) {
    console.error("inbound insert", insertError.message);
    return json({ error: "insert_failed" }, 500); // Resend retries
  }

  if (status === "pending") {
    const recipients = await householdMemberIds(admin, householdId);
    await sendPushToUsers(admin, recipients, "inbound_invoices", {
      title: "Factura nueva por correo",
      body: invoice ? `${invoice.issuer || "Factura"}${invoice.total ? ` · ₡${Math.round(invoice.total).toLocaleString("es-CR")}` : ""}` : subject || "Revisa la factura recibida",
      url: "/?tab=dashboard",
      tag: `inbound-${householdId}`,
    });
  }
  return json({ ok: status }, 200);
}

async function cleanup(admin: SupabaseClient) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  const { data: old } = await admin
    .from("inbound_invoices")
    .select("id, xml_path, pdf_path")
    .in("status", ["imported", "rejected", "duplicate", "error"])
    .lt("received_at", cutoff)
    .or("xml_path.not.is.null,pdf_path.not.is.null")
    .limit(500);
  const paths = ((old ?? []) as Row[]).flatMap((r) => [r.xml_path, r.pdf_path]).filter((p): p is string => typeof p === "string");
  if (paths.length) await admin.storage.from(BUCKET).remove(paths);
  if (old?.length) {
    await admin
      .from("inbound_invoices")
      .update({ xml_path: null, pdf_path: null })
      .in("id", (old as Row[]).map((r) => String(r.id)));
  }
  return { removed: paths.length };
}

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const body = await req.text();
  try {
    const admin = serviceClient();
    if (isCronRequest(req)) {
      const parsed = JSON.parse(body || "{}") as Row;
      if (parsed.action === "cleanup") return json(await cleanup(admin), 200);
      return json({ error: "bad_request" }, 400);
    }
    if (!(await verifySvix(req, body))) return json({ error: "bad_signature" }, 401);
    const event = JSON.parse(body) as Row;
    if (event.type !== "email.received") return json({ ignored: event.type }, 200);
    return await handleEmail(admin, (event.data ?? {}) as Row);
  } catch (err) {
    console.error("inbound-invoice:", err);
    return json({ error: "internal" }, 500);
  }
});
