// ============================================================================
// Edge Function `inbound-invoice`: webhook for Resend Inbound ("email.received").
// Invoices reach <alias>@<INBOUND_DOMAIN> (the household's readable name, which can be given
// straight to a store) or the older facturas+<code>@<INBOUND_DOMAIN>. A Costa Rican e-invoice
// email carries three files: the invoice XML, Hacienda's response XML (MensajeHacienda) and the
// PDF. All three are stored in the private bucket `inbound-invoices` and a row goes to
// inbound_invoices. Only a complete set accepted by Hacienda is imported automatically; an
// incomplete one waits for review with a warning, and an email with no invoice data is
// recorded as an error (the app tells the household) and nothing is stored.
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

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
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

const RESPONSE_ROOT = /<(?:\w+:)?MensajeHacienda[\s>]/;

interface HaciendaResponse {
  clave: string;
  status: string; // "aceptado" | "rechazado" | whatever Hacienda wrote, lowercased
  issuer: string;
  total: number;
}

function readResponseXml(xml: string): HaciendaResponse | null {
  if (!RESPONSE_ROOT.test(xml)) return null;
  const clave = tag(xml, "Clave");
  if (!/^\d{50}$/.test(clave)) return null;
  return {
    clave,
    status: tag(xml, "EstadoMensaje").toLowerCase().slice(0, 40),
    issuer: tag(xml, "NombreEmisor").slice(0, 120),
    total: Number(tag(xml, "TotalFactura").replace(",", ".")) || 0,
  };
}

/** The 50-digit key many systems use as the PDF's file name */
const claveInName = (filename: string): string | null => filename.match(/(?<!\d)(\d{50})(?!\d)/)?.[1] ?? null;

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

/**
 * XML and PDF attachments of a received email, plus how many other files it had.
 * Null when Resend's API can't be read (e.g. a sending-only API key): the caller answers 500
 * so Resend retries, instead of recording a valid invoice as "no invoice".
 */
async function fetchAttachments(emailId: string): Promise<{ files: InboundAttachment[]; others: number } | null> {
  const list = await resendGet(`/emails/receiving/${encodeURIComponent(emailId)}/attachments`);
  if (!list) return null;
  const items = (Array.isArray(list.data) ? list.data : []) as Row[];
  const files: InboundAttachment[] = [];
  let others = 0;
  for (const a of items) {
    const filename = String(a.filename ?? "adjunto");
    const contentType = String(a.content_type ?? "");
    const wanted = /\.(xml|pdf)$/i.test(filename) || /xml|pdf/i.test(contentType);
    if (!wanted) {
      if (!/^inline$/i.test(String(a.content_disposition ?? ""))) others++; // logos in the body don't count
      continue;
    }
    if (Number(a.size ?? 0) > MAX_ATTACHMENT_BYTES || typeof a.download_url !== "string") continue;
    const res = await fetch(a.download_url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) continue;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length <= MAX_ATTACHMENT_BYTES) files.push({ filename, contentType, bytes });
  }
  return { files, others };
}

// ---------------------------------------------------------------------------
// Handling
// ---------------------------------------------------------------------------

/** This project's receiving domain; empty = accept any domain (single-environment setups). */
function inboundDomain(): string {
  return (Deno.env.get("INBOUND_DOMAIN") ?? "").trim().toLowerCase().replace(/^@/, "");
}

/** Local parts (before the @) of the addresses on this project's domain, in order. */
function localParts(addresses: string[], domain: string): string[] {
  const out: string[] = [];
  for (const raw of addresses) {
    const address = (raw.match(/<([^>]+)>/)?.[1] ?? raw).trim().toLowerCase();
    const m = address.match(/^([^@\s]+)@([^@\s]+)$/);
    if (m && (!domain || m[2] === domain) && !out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * Household that owns one of the addresses: facturas+<code>, <alias> (hyphens, dots and
 * underscores ignored, so a cashier who drops a hyphen still gets it right) or a bare <code>.
 */
async function findMailbox(admin: SupabaseClient, locals: string[]): Promise<Row | null> {
  const select = "household_id, is_active, households(plan)";
  for (const local of locals) {
    const plus = local.match(/^[^+]+\+([a-z0-9]{8,16})$/);
    if (plus) {
      const { data } = await admin.from("invoice_mailboxes").select(select).eq("code", plus[1]).maybeSingle();
      if (data) return data as Row;
      continue;
    }
    const key = local.replace(/[-._]/g, "");
    if (!/^[a-z0-9]{3,30}$/.test(key)) continue;
    const { data: alias } = await admin
      .from("invoice_mailbox_aliases")
      .select("household_id")
      .eq("alias_key", key)
      .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`)
      .maybeSingle();
    if (alias) {
      const { data } = await admin.from("invoice_mailboxes").select(select).eq("household_id", alias.household_id).maybeSingle();
      if (data) return data as Row;
      continue;
    }
    if (/^[a-z0-9]{8,16}$/.test(local)) {
      const { data } = await admin.from("invoice_mailboxes").select(select).eq("code", local).maybeSingle();
      if (data) return data as Row;
    }
  }
  return null;
}

const asList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === "string" ? [v] : []);

async function handleEmail(admin: SupabaseClient, data: Row): Promise<Response> {
  // Gmail forwarding keeps the original To header; our facturas+<code>@ address only shows up in received_for.
  // Only addresses on this project's domain count; mail for the other environment is dropped here, without logging it.
  const locals = localParts([...asList(data.received_for), ...asList(data.to), ...asList(data.cc), ...asList(data.bcc)], inboundDomain());
  if (locals.length === 0) return json({ ignored: "no_code_for_this_domain" }, 200);

  const mailbox = await findMailbox(admin, locals);
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

  const fetched = data.email_id ? await fetchAttachments(String(data.email_id)) : { files: [], others: 0 };
  if (!fetched) return json({ error: "attachments_unavailable" }, 500); // Resend retries

  // Sort the files: invoice XML, Hacienda's response XML, PDF
  const decoder = new TextDecoder();
  let invoice: ReturnType<typeof readInvoiceXml> = null;
  let invoiceFile: InboundAttachment | null = null;
  let response: HaciendaResponse | null = null;
  let responseFile: InboundAttachment | null = null;
  const pdfs: InboundAttachment[] = [];
  for (const a of fetched.files) {
    if (/\.pdf$/i.test(a.filename) || /pdf/i.test(a.contentType)) {
      pdfs.push(a);
      continue;
    }
    const xml = decoder.decode(a.bytes);
    if (!invoice) {
      const parsed = readInvoiceXml(xml);
      if (parsed) {
        invoice = parsed;
        invoiceFile = a;
        continue;
      }
    }
    if (!response) {
      const parsed = readResponseXml(xml);
      if (parsed) {
        response = parsed;
        responseFile = a;
      }
    }
  }
  const clave = invoice?.clave ?? response?.clave ?? pdfs.map((p) => claveInName(p.filename)).find(Boolean) ?? null;
  // A response for another invoice doesn't count
  if (response && invoice && response.clave !== invoice.clave) {
    response = null;
    responseFile = null;
  }
  // Prefer the PDF named after this invoice's key; a PDF alone must carry the key in its name
  const pdf =
    pdfs.find((p) => clave && claveInName(p.filename) === clave) ??
    (invoice || response ? pdfs.find((p) => !claveInName(p.filename)) : undefined) ??
    null;

  const id = crypto.randomUUID();
  if (!invoice && !response && !pdf) {
    // Nothing that looks like an e-invoice: recorded only so the app can tell the household
    const detail = fetched.files.length + fetched.others === 0
      ? "El correo no traía archivos adjuntos"
      : "Los adjuntos no son una factura electrónica (se necesitan el XML y el PDF de Hacienda)";
    await admin.from("inbound_invoices").insert({
      id,
      household_id: householdId,
      sender,
      subject,
      status: "error",
      error_detail: detail,
      processed_at: new Date().toISOString(),
    });
    return json({ ok: "no_invoice" }, 200);
  }

  const missing = [!invoice && "factura", !response && "respuesta", !pdf && "pdf"].filter((m): m is string => Boolean(m));
  const isComplete = missing.length === 0;

  let status: "pending" | "duplicate" = "pending";
  if (clave) {
    const { data: existing } = await admin
      .from("inbound_invoices")
      .select("id")
      .eq("household_id", householdId)
      .eq("clave", clave)
      .neq("status", "duplicate")
      .limit(1);
    if (existing && existing.length > 0) status = "duplicate";
  }

  const store = async (file: InboundAttachment | null, suffix: string, contentType: string): Promise<string | null> => {
    if (!file || status !== "pending") return null;
    const path = `${householdId}/${id}${suffix}`;
    const { error } = await admin.storage.from(BUCKET).upload(path, file.bytes, { contentType });
    if (error) console.error("inbound upload", suffix, error.message);
    return error ? null : path;
  };
  const xmlPath = await store(invoiceFile, ".xml", "application/xml");
  const responsePath = await store(responseFile, "-respuesta.xml", "application/xml");
  const pdfPath = await store(pdf, ".pdf", "application/pdf");

  const { error: insertError } = await admin.from("inbound_invoices").insert({
    id,
    household_id: householdId,
    sender,
    subject,
    clave,
    issuer: invoice?.issuer || response?.issuer || null,
    total: invoice?.total || response?.total || null,
    issued_at: invoice?.issuedAt ?? null,
    status,
    xml_path: xmlPath,
    response_path: responsePath,
    pdf_path: pdfPath,
    file_names: {
      ...(xmlPath && invoiceFile ? { factura: invoiceFile.filename } : {}),
      ...(responsePath && responseFile ? { respuesta: responseFile.filename } : {}),
      ...(pdfPath && pdf ? { pdf: pdf.filename } : {}),
    },
    hacienda_status: response?.status || null,
    is_complete: isComplete,
    missing,
  });
  if (insertError) {
    console.error("inbound insert", insertError.message);
    return json({ error: "insert_failed" }, 500); // Resend retries
  }

  if (status === "pending") {
    const issuer = invoice?.issuer || response?.issuer || "";
    const total = invoice?.total || response?.total || 0;
    const recipients = await householdMemberIds(admin, householdId);
    await sendPushToUsers(admin, recipients, "inbound_invoices", {
      title: isComplete ? "Factura nueva por correo" : "Factura incompleta por correo",
      body: `${issuer || subject || "Revisa la factura recibida"}${total ? ` · ₡${Math.round(total).toLocaleString("es-CR")}` : ""}`,
      url: "/?tab=dashboard",
      tag: `inbound-${householdId}`,
    });
  }
  return json({ ok: status, complete: isComplete, missing }, 200);
}

async function cleanup(admin: SupabaseClient) {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
  const { data: old } = await admin
    .from("inbound_invoices")
    .select("id, xml_path, response_path, pdf_path")
    // Imported invoices keep their files: the purchase shows the PDF and XML
    .in("status", ["rejected", "duplicate", "error"])
    .lt("received_at", cutoff)
    .or("xml_path.not.is.null,response_path.not.is.null,pdf_path.not.is.null")
    .limit(500);
  const paths = ((old ?? []) as Row[])
    .flatMap((r) => [r.xml_path, r.response_path, r.pdf_path])
    .filter((p): p is string => typeof p === "string");
  if (paths.length) await admin.storage.from(BUCKET).remove(paths);
  if (old?.length) {
    await admin
      .from("inbound_invoices")
      .update({ xml_path: null, response_path: null, pdf_path: null })
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
