// ============================================================================
// Supabase Edge Function: assistant
// Keeps GEMINI_API_KEY strictly on the server for all AI operations:
// - scan-receipt (Multimodal Vision OCR + Product Normalization, with a
//   deterministic sum check against the printed total and one repair pass)
// - parse-shopping-input (Natural language shopping list breakdown)
// - match-shopping-list (Semantic auto-cross-off matching)
// - generate-insights (Monthly budget & restock narrative generation)
// - assistant-chat (Conversational household grocery analyst)
// ============================================================================

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";
import {
  buildRepairPrompt,
  buildScanReceiptPrompt,
  needsRepairPass,
  receiptErrorScore,
  reconcileReceipt,
  SCAN_RECEIPT_RESPONSE_SCHEMA,
  type ExtractedReceipt,
} from "../_shared/receiptExtraction.ts";

// Allowed web origins: secret ALLOWED_ORIGINS="https://app.example.com,https://otra.example.com".
// Without it only local development origins (localhost and private LAN IPs) are accepted.
const LOCAL_ORIGIN =
  /^https?:\/\/(localhost|127\.0\.0\.1|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)(:\d+)?$/;

function isAllowedOrigin(origin: string): boolean {
  const configured = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((o) => o.trim().replace(/\/$/, ""))
    .filter(Boolean);
  return configured.length > 0 ? configured.includes(origin) : LOCAL_ORIGIN.test(origin);
}

function corsHeadersFor(origin: string): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    Vary: "Origin",
  };
}

/** Failure the client may see: only a fixed code and a generic Spanish text. */
class PublicError extends Error {
  constructor(readonly code: "busy" | "internal" | "bad_request", readonly status: number) {
    super(code);
  }
}

const PUBLIC_MESSAGES: Record<string, string> = {
  busy: "El servicio de lectura está ocupado. Inténtalo en unos minutos.",
  internal: "No se pudo completar la solicitud. Inténtalo más tarde.",
  bad_request: "Solicitud no válida.",
  unauthorized: "Sesión no válida.",
  forbidden: "Origen no permitido.",
};

// Plan B when a model is overloaded or retired: try each model in order.
// Override without redeploying: supabase secrets set GEMINI_MODELS="model-a,model-b"
const DEFAULT_GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"];
const RETRY_DELAYS_MS = [1500, 4000];
// Edge Functions are cut off near 150 s: one call (all retries and models) stays under this
const CALL_BUDGET_MS = 110_000;
const REQUEST_BUDGET_MS = 140_000;
// The receipt repair pass only runs when the first pass left enough time
const REPAIR_PASS_MAX_FIRST_MS = 45_000;

function geminiModels(): string[] {
  const configured = (Deno.env.get("GEMINI_MODELS") ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  return configured.length > 0 ? configured : DEFAULT_GEMINI_MODELS;
}

class GeminiHttpError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

// 429/5xx = busy or down (worth retrying); 404/"no longer available" = try the next model
const isTransient = (status: number) => status === 429 || status >= 500;
const isModelUnavailable = (err: GeminiHttpError) =>
  err.status === 404 || /no longer available|not found|not supported/i.test(err.message);

async function callGeminiModel(
  model: string,
  apiKey: string,
  contents: unknown[],
  responseMimeType: string,
  responseSchema: unknown,
  timeoutMs: number
): Promise<unknown> {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  const geminiRes = await fetch(endpoint, {
    method: "POST",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents,
      generationConfig: {
        responseMimeType,
        ...(responseSchema ? { responseSchema } : {}),
      },
    }),
  });
  const geminiData = await geminiRes.json().catch(() => null);
  if (!geminiRes.ok) {
    throw new GeminiHttpError(
      geminiData?.error?.message || `Gemini error ${geminiRes.status}`,
      geminiRes.status
    );
  }
  const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
  return responseMimeType === "application/json" ? JSON.parse(rawText) : { reply: rawText };
}

async function callGemini(
  apiKey: string,
  contents: unknown[],
  responseMimeType: string,
  responseSchema?: unknown,
  budgetMs = CALL_BUDGET_MS
): Promise<unknown> {
  const deadline = Date.now() + budgetMs;
  const remaining = () => deadline - Date.now();
  let lastError: unknown = null;
  for (const model of geminiModels()) {
    for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
      if (remaining() < 1000) {
        throw new PublicError("busy", 503);
      }
      try {
        return await callGeminiModel(model, apiKey, contents, responseMimeType, responseSchema, remaining());
      } catch (err) {
        lastError = err;
        if (err instanceof DOMException && err.name === "TimeoutError") {
          throw new PublicError("busy", 503);
        }
        if (!(err instanceof GeminiHttpError)) throw err;
        if (isModelUnavailable(err) || !isTransient(err.status)) break;
        const delay = RETRY_DELAYS_MS[attempt];
        if (delay !== undefined && delay < remaining() - 1000) {
          await new Promise((r) => setTimeout(r, delay));
        }
      }
    }
    // Errors no other model would fix (bad key, bad request) stop here
    if (
      lastError instanceof GeminiHttpError &&
      !isModelUnavailable(lastError) &&
      !isTransient(lastError.status)
    ) {
      throw lastError;
    }
  }
  throw lastError ?? new Error("No Gemini model available");
}

function jsonError(code: string, status: number, headers: Record<string, string>): Response {
  return new Response(JSON.stringify({ error: PUBLIC_MESSAGES[code] ?? PUBLIC_MESSAGES.internal, code }), {
    status,
    headers: { ...headers, "Content-Type": "application/json" },
  });
}

serve(async (req: Request) => {
  // Browsers always send Origin; server-to-server calls (no Origin) still need a signed-in user below
  const origin = req.headers.get("Origin") ?? "";
  if (origin && !isAllowedOrigin(origin)) {
    return jsonError("forbidden", 403, {});
  }
  const corsHeaders = origin ? corsHeadersFor(origin) : {};

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  // Only signed-in Canastica users may spend the Gemini quota (the public anon key alone is not enough)
  const authHeader = req.headers.get("Authorization") ?? "";
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_ANON_KEY") ?? "",
    { global: { headers: { Authorization: authHeader } } }
  );
  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return jsonError("unauthorized", 401, corsHeaders);
  }

  try {
    const apiKey = Deno.env.get("GEMINI_API_KEY");
    if (!apiKey) {
      console.error("assistant: GEMINI_API_KEY secret is missing");
      return jsonError("internal", 500, corsHeaders);
    }

    const { action, payload } = await req.json();

    let contents: unknown[] = [];
    let responseMimeType = "application/json";

    if (action === "scan-receipt") {
      const { base64Image, mimeType } = payload;
      const language = payload.language === "en" ? "en" : "es";
      const image = { inline_data: { mime_type: mimeType || "image/jpeg", data: base64Image } };

      // Pass 1: structured extraction, then deterministic clean-up and sum check
      const scanStart = Date.now();
      const first = reconcileReceipt(
        await callGemini(
          apiKey,
          [{ parts: [{ text: buildScanReceiptPrompt(language) }, image] }],
          "application/json",
          SCAN_RECEIPT_RESPONSE_SCHEMA
        ) as Partial<ExtractedReceipt>
      );
      let best = first;

      // Pass 2 (only when the items do not add up to the printed total and pass 1 was quick)
      const firstPassMs = Date.now() - scanStart;
      if (needsRepairPass(first) && firstPassMs < REPAIR_PASS_MAX_FIRST_MS) {
        try {
          const second = reconcileReceipt(
            await callGemini(
              apiKey,
              [{ parts: [{ text: buildRepairPrompt(language, first) }, image] }],
              "application/json",
              SCAN_RECEIPT_RESPONSE_SCHEMA,
              Math.min(CALL_BUDGET_MS, REQUEST_BUDGET_MS - firstPassMs)
            ) as Partial<ExtractedReceipt>
          );
          if (!second.isBlurry && receiptErrorScore(second) < receiptErrorScore(first)) {
            best = { ...second, validation: { ...second.validation!, repaired: true } };
          }
        } catch {
          // keep the first pass
        }
      }

      return new Response(JSON.stringify(best), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } else if (action === "parse-shopping-input") {
      const { text } = payload;
      const prompt = `Break down the following natural language grocery shopping request into individual structured items in English.
Translate any Spanish or bilingual terms into clean English product names.
Input: "${text}"
Return JSON array:
[
  {
    "name": "Clean item name in English",
    "canonicalName": "Generic product group e.g. Milk, Whole Wheat Bread, Laundry Detergent",
    "category": "One of: Dairy & Eggs, Meat & Poultry, Produce, Bakery, Pantry Staples, Beverages, Snacks, Cleaning & Home, Personal Care",
    "quantity": 2,
    "unit": "L | ml | kg | g | loaves | units | bottles | packs"
  }
]`;
      contents = [{ parts: [{ text: prompt }] }];
    } else if (action === "match-shopping-list") {
      const { shoppingListItems, purchasedItems } = payload;
      const prompt = `Compare the household's pending shopping list items with the newly purchased items.
Match items even if one is generic or in Spanish/English and the other is a specific brand/presentation (e.g. "leche" or "Milk" matches "Milk Dos Pinos 1L").
Shopping List Items: ${JSON.stringify(shoppingListItems)}
Purchased Items: ${JSON.stringify(purchasedItems)}
Return JSON:
{
  "matches": [
    {
      "shoppingListItemId": "id",
      "shoppingListItemName": "name",
      "matchedPurchasedItemName": "normalizedName",
      "confidence": 0.95
    }
  ]
}`;
      contents = [{ parts: [{ text: prompt }] }];
    } else if (action === "generate-insights") {
      const { householdContext } = payload;
      const prompt = `Based on this household's grocery spending and restock data:
${JSON.stringify(householdContext)}
Generate a concise, friendly monthly summary and one practical money-saving suggestion in English.
Return JSON:
{
  "headline": "Short 1-sentence summary of budget pace and category trends",
  "suggestion": "1 practical actionable suggestion based on their numbers"
}`;
      contents = [{ parts: [{ text: prompt }] }];
    } else if (action === "assistant-chat") {
      responseMimeType = "text/plain";
      const { question, householdContext } = payload;
      const prompt = `You are Canastica AI, a helpful and concise household grocery and finance assistant.
Answer the user's question in English using the exact figures from the household data below.
Household Data:
${JSON.stringify(householdContext)}

User Question: "${question}"`;
      contents = [{ parts: [{ text: prompt }] }];
    } else {
      throw new PublicError("bad_request", 400);
    }

    const result = await callGemini(apiKey, contents, responseMimeType);

    return new Response(JSON.stringify(result), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    // Full detail stays in the function logs; the client only gets a code
    console.error("assistant:", error instanceof Error ? error.stack ?? error.message : error);
    if (error instanceof PublicError) return jsonError(error.code, error.status, corsHeaders);
    if (error instanceof GeminiHttpError && isTransient(error.status)) {
      return jsonError("busy", 503, corsHeaders);
    }
    return jsonError("internal", 500, corsHeaders);
  }
});
