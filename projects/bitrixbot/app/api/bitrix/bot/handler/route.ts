import { NextResponse } from "next/server";
import { createHash } from "node:crypto";
import { routeBitrixWebhook } from "@/lib/bitrix/webhook-router";
import { supabaseServiceRoleForRoute } from "@/lib/supabase/route";
import { normalizeBitrixCallEvent } from "@/lib/bitrix/call-normalize";
import { normalizeBitrixDealEvent } from "@/lib/bitrix/deal-normalize";

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
    /token|secret|key|password|refresh|access|application_token/i.test(k);

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

/** Полные data/auth — только при BITRIX_WEBHOOK_VERBOSE_LOGS=1. */
const VERBOSE_WEBHOOK_LOG =
  typeof process.env.BITRIX_WEBHOOK_VERBOSE_LOGS === "string" &&
  ["1", "true", "yes"].includes(process.env.BITRIX_WEBHOOK_VERBOSE_LOGS.toLowerCase());

function pickStr(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

function summarizeWebhookForLog(
  event: string | null,
  category: string,
  payloadObj: JsonObject
): Record<string, unknown> {
  const data = (payloadObj.data ?? payloadObj.DATA) as unknown;
  const d = toJsonObject(data);
  const base: Record<string, unknown> = {
    event: event ?? "",
    category
  };

  if (category === "call") {
    return {
      ...base,
      call_id: pickStr(d.CALL_ID) ?? pickStr(d.CALL_APP_ID) ?? pickStr(d.ID),
      crm_activity_id: pickStr(d.CRM_ACTIVITY_ID),
      portal_user_id: pickStr(d.PORTAL_USER_ID) ?? pickStr(d.USER_ID)
    };
  }

  if (event === "ONCRMDEALADD" || event === "ONCRMDEALUPDATE") {
    const fields = d.FIELDS;
    const fObj = fields && typeof fields === "object" && !Array.isArray(fields) ? (fields as JsonObject) : {};
    return {
      ...base,
      deal_id: pickStr(fObj.ID) ?? pickStr(d.ID)
    };
  }

  return {
    ...base,
    data_top_keys: Object.keys(d).slice(0, 16)
  };
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const raw = await req.text();
    const params = new URLSearchParams(raw);
    const out: Record<string, unknown> = {};

    const parseKeyPath = (key: string): string[] => {
      const parts: string[] = [];
      const re = /([^[\]]+)|\[([^\]]*)\]/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(key))) {
        const part = (m[1] ?? m[2] ?? "").trim();
        if (part) parts.push(part);
      }
      return parts.length ? parts : [key];
    };

    const setDeep = (obj: Record<string, unknown>, path: string[], value: unknown) => {
      let cur: Record<string, unknown> = obj;
      for (let i = 0; i < path.length; i++) {
        const k = path[i]!;
        const isLast = i === path.length - 1;
        if (isLast) {
          cur[k] = value;
          return;
        }

        const next = cur[k];
        if (!next || typeof next !== "object" || Array.isArray(next)) {
          const created: Record<string, unknown> = {};
          cur[k] = created;
          cur = created;
        } else {
          cur = next as Record<string, unknown>;
        }
      }
    };

    for (const [k, v] of params.entries()) {
      const value = tryParseJson(v);
      setDeep(out, parseKeyPath(k), value);
    }

    return out;
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
  const receivedAt = Date.now();
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

    if (VERBOSE_WEBHOOK_LOG) {
      console.log("[bitrix-bot-handler] received", {
        event: event ?? "",
        category: routing.category,
        hasEventToken: Boolean(eventToken),
        dedupeKeyPrefix: dedupeKey.split(":")[0],
        data: redactSecrets(data),
        auth: redactSecrets(auth)
      });
    } else {
      console.log("[bitrix-bot-handler] received", {
        hasEventToken: Boolean(eventToken),
        dedupeKeyPrefix: dedupeKey.split(":")[0],
        ...summarizeWebhookForLog(event, routing.category, obj)
      });
    }

    const supabase = supabaseServiceRoleForRoute();
    const { data: inserted, error } = await supabase
      .from("bitrix_webhook_events")
      .insert({
      event_name: event,
      event_token: eventToken,
      dedupe_key: dedupeKey,
      payload,
      processing_status: "pending"
      })
      .select("id")
      .single();

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

    const webhookEventId = inserted?.id as string | undefined;

    try {
      if (event && routing.category === "call") {
        if (event === "ONVOXIMPLANTCALLINIT" || event === "ONVOXIMPLANTCALLSTART") {
          await supabase
            .from("bitrix_webhook_events")
            .update({ processing_status: "ignored" })
            .eq("id", webhookEventId ?? "");
          return NextResponse.json({ ok: true, duplicate: false });
        }

        const normalized = normalizeBitrixCallEvent(event, payload);
        if (!normalized) {
          await supabase
            .from("bitrix_webhook_events")
            .update({ processing_status: "ignored" })
            .eq("id", webhookEventId ?? "");
          return NextResponse.json({ ok: true, duplicate: false });
        }

        const { error: callErr } = await supabase.from("call_events").insert({
          manager_bitrix_user_id: normalized.manager_bitrix_user_id,
          bitrix_deal_id: normalized.bitrix_deal_id,
          phone: normalized.phone,
          phone_normalized: normalized.phone_normalized,
          status: normalized.status,
          crm_activity_id: normalized.crm_activity_id,
          bitrix_call_id: normalized.bitrix_call_id,
          call_type_raw: normalized.call_type_raw,
          call_direction: normalized.call_direction,
          call_duration_seconds: normalized.call_duration_seconds,
          failed_code: normalized.failed_code,
          failed_reason: normalized.failed_reason,
          call_started_at: normalized.call_started_at,
          occurred_at: normalized.occurred_at,
          raw_payload: normalized.raw_payload
        });

        if (callErr) throw new Error(callErr.message);

        console.log("[bitrix-call-ingest]", {
          saved: true,
          webhookEvent: event ?? "",
          status: normalized.status,
          callType: normalized.call_type_raw,
          direction: normalized.call_direction,
          duration: normalized.call_duration_seconds,
          failedCode: normalized.failed_code,
          phone: normalized.phone_normalized,
          manager: normalized.manager_bitrix_user_id,
          activity: normalized.crm_activity_id,
          bitrixCallId: normalized.bitrix_call_id
        });

        await supabase
          .from("bitrix_webhook_events")
          .update({ processing_status: "processed" })
          .eq("id", webhookEventId ?? "");

        console.log("[bitrix-bot-handler] call_event inserted", {
          status: normalized.status,
          durationMs: Date.now() - receivedAt
        });

        return NextResponse.json({ ok: true, duplicate: false });
      }

      if (event === "ONCRMDEALADD" || event === "ONCRMDEALUPDATE") {
        const normalized = normalizeBitrixDealEvent(event, payload);
        if (!normalized) {
          await supabase
            .from("bitrix_webhook_events")
            .update({ processing_status: "ignored" })
            .eq("id", webhookEventId ?? "");
          return NextResponse.json({ ok: true, duplicate: false });
        }

        const { error: dealErr } = await supabase.from("deal_events").insert({
          event_name: normalized.event_name,
          bitrix_deal_id: normalized.bitrix_deal_id,
          stage_id: normalized.stage_id,
          category_id: normalized.category_id,
          assigned_by_id: normalized.assigned_by_id,
          created_by_id: normalized.created_by_id,
          title: normalized.title,
          opportunity: normalized.opportunity,
          currency: normalized.currency,
          is_new: normalized.is_new,
          occurred_at: normalized.occurred_at,
          raw_payload: normalized.raw_payload
        });
        if (dealErr) throw new Error(dealErr.message);

        await supabase
          .from("bitrix_webhook_events")
          .update({ processing_status: "processed" })
          .eq("id", webhookEventId ?? "");

        console.log("[bitrix-bot-handler] deal_event inserted", {
          event,
          bitrixDealId: normalized.bitrix_deal_id,
          durationMs: Date.now() - receivedAt
        });

        return NextResponse.json({ ok: true, duplicate: false });
      }

      await supabase
        .from("bitrix_webhook_events")
        .update({ processing_status: "ignored" })
        .eq("id", webhookEventId ?? "");

      return NextResponse.json({ ok: true, duplicate: false });
    } catch (inner) {
      const msg = inner instanceof Error ? inner.message : String(inner);
      await supabase
        .from("bitrix_webhook_events")
        .update({ processing_status: "failed", error_message: msg })
        .eq("id", webhookEventId ?? "");
      throw inner;
    }
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

