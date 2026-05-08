import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { routeBitrixWebhook } from "@/lib/bitrix/webhook-router";
import { supabaseServiceRoleForRoute } from "@/lib/supabase/route";

type JsonObject = Record<string, unknown>;

function tryParseJson(value: string): unknown {
  const v = value.trim();
  if (!v) return value;
  if (
    (v.startsWith("{") && v.endsWith("}")) ||
    (v.startsWith("[") && v.endsWith("]"))
  ) {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function redactSecrets(input: unknown): unknown {
  const shouldRedactKey = (k: string) =>
    /token|secret|key|password|refresh|access/i.test(k);

  if (Array.isArray(input)) return input.map(redactSecrets);
  if (!input || typeof input !== "object") return input;

  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (shouldRedactKey(k)) out[k] = "***";
    else out[k] = redactSecrets(v);
  }
  return out;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const raw = await req.text();
    const params = new URLSearchParams(raw);
    const data: Record<string, unknown> = {};
    for (const [k, v] of params.entries()) data[k] = tryParseJson(v);
    return data;
  }

  if (contentType.includes("application/json")) {
    const json = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return json ?? {};
  }

  const text = await req.text().catch(() => "");
  return text ? { raw: text } : {};
}

function toJsonObject(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
  return {};
}

function stableStringify(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(String(value));
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function pickEventToken(payload: JsonObject): string | null {
  const candidates = [
    payload.event_token,
    payload.eventToken,
    payload.event_id,
    payload.eventId,
    payload.event_id,
    payload.id,
    payload.ID
  ];

  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c;
    if (typeof c === "number") return String(c);
  }

  const auth = payload.auth;
  if (auth && typeof auth === "object" && !Array.isArray(auth)) {
    const authObj = auth as Record<string, unknown>;
    const authCandidates = [authObj.event_token, authObj.token, authObj.id];
    for (const c of authCandidates) {
      if (typeof c === "string" && c.trim()) return c;
      if (typeof c === "number") return String(c);
    }
  }

  return null;
}

function buildDedupeKey(eventName: string | null, eventToken: string | null, payload: unknown): string {
  if (eventToken) return `token:${eventToken}`;
  const base = `${eventName ?? ""}:${stableStringify(payload)}`;
  return `hash:${sha256Hex(base)}`;
}

export async function POST(req: Request) {
  try {
    const body = await readBody(req);

    const payload = body as unknown;
    const obj = toJsonObject(payload);

    const event =
      (typeof obj.event === "string" ? obj.event : undefined) ??
      (typeof obj.EVENT === "string" ? obj.EVENT : undefined) ??
      null;

    const eventToken = pickEventToken(obj);
    const dedupeKey = buildDedupeKey(event, eventToken, payload);

    const data = obj.data ?? obj.DATA ?? null;
    const auth = obj.auth ?? obj.AUTH ?? null;

    const routing = routeBitrixWebhook(payload);

    console.log("[bitrix-bot-handler] received", {
      event: event ?? "",
      category: routing.category,
      hasEventToken: Boolean(eventToken),
      dedupeKeyPrefix: dedupeKey.split(":")[0],
      data: redactSecrets(data),
      auth: redactSecrets(auth)
    });

    const supabase = supabaseServiceRoleForRoute();
    const { error } = await supabase.from("bitrix_webhook_events").insert({
      event_name: event,
      event_token: eventToken,
      dedupe_key: dedupeKey,
      payload,
      processing_status: "pending"
    });

    if (error) {
      const code = (error as { code?: string }).code;
      if (code === "23505") {
        console.log("[bitrix-bot-handler] duplicate", {
          event: event ?? "",
          dedupeKeyPrefix: dedupeKey.split(":")[0]
        });
        return NextResponse.json({ ok: true, duplicate: true });
      }

      console.log("[bitrix-bot-handler] insert failed", {
        message: error.message,
        code
      });
      return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
    }

    return NextResponse.json({ ok: true, duplicate: false });
  } catch (e) {
    console.log("[bitrix-bot-handler] error", {
      message: e instanceof Error ? e.message : String(e)
    });
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 }
    );
  }
}

