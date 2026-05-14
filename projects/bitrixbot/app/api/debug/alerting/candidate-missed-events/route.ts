import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";

function isAuthorized(req: Request): boolean {
  const header = req.headers.get("x-debug-secret") ?? "";
  const url = new URL(req.url);
  const query = url.searchParams.get("secret") ?? "";
  const secret = header || query;
  return Boolean(secret && secret === env.DEBUG_SECRET);
}

function webhookEventPreview(raw_payload: unknown): string | null {
  if (!raw_payload || typeof raw_payload !== "object") return null;
  const root = raw_payload as Record<string, unknown>;
  const e = root.event ?? root.EVENT;
  return typeof e === "string" ? e.trim() || null : null;
}

/** Diagnose missed-call column candidates (+ processing row attachment). Temporary debug. */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const phoneRaw = (url.searchParams.get("phone") ?? "").trim();
  const phone = phoneRaw.replace(/\D/g, "") || phoneRaw;
  const limitRaw = Number(url.searchParams.get("limit") ?? "80");
  const limit = Number.isFinite(limitRaw) ? Math.min(300, Math.max(1, Math.floor(limitRaw))) : 80;

  const supabase = createServiceRoleClient();

  let q = supabase
    .from("call_events")
    .select("id, occurred_at, phone_normalized, manager_bitrix_user_id, call_type_raw, failed_code, raw_payload")
    .eq("call_type_raw", "2")
    .eq("failed_code", "304")
    .not("manager_bitrix_user_id", "is", null)
    .not("phone_normalized", "is", null)
    .order("occurred_at", { ascending: false })
    .limit(limit);

  if (phone) {
    q = q.eq("phone_normalized", phone);
  }

  const { data: events, error: evErr } = await q;
  if (evErr) {
    return NextResponse.json({ ok: false, error: evErr.message }, { status: 500 });
  }

  const rows = (events ?? []) as {
    id: string;
    occurred_at: string;
    phone_normalized: string | null;
    manager_bitrix_user_id: string | null;
    call_type_raw: string | null;
    failed_code: string | null;
    raw_payload: unknown;
  }[];

  const ids = rows.map((r) => r.id);
  const procMap = new Map<
    string,
    { processing_status: string | null; case_id: string | null }
  >();

  if (ids.length > 0) {
    const { data: procRows, error: procErr } = await supabase
      .from("call_event_case_processing")
      .select("call_event_id, processing_status, case_id")
      .in("call_event_id", ids);

    if (procErr) {
      return NextResponse.json({ ok: false, error: procErr.message }, { status: 500 });
    }
    for (const p of procRows ?? []) {
      const row = p as { call_event_id: string; processing_status: string | null; case_id: string | null };
      procMap.set(row.call_event_id, {
        processing_status: row.processing_status,
        case_id: row.case_id
      });
    }
  }

  const items = rows.map((r) => ({
    id: r.id,
    occurred_at: r.occurred_at,
    phone_normalized: r.phone_normalized,
    manager_bitrix_user_id: r.manager_bitrix_user_id,
    call_type_raw: r.call_type_raw,
    failed_code: r.failed_code,
    raw_payload_event: webhookEventPreview(r.raw_payload),
    processing_row: procMap.has(r.id),
    processing_status: procMap.get(r.id)?.processing_status ?? null,
    case_id: procMap.get(r.id)?.case_id ?? null
  }));

  return NextResponse.json({
    ok: true,
    filters: {
      phone: phone || null,
      call_type_raw: "2",
      failed_code: "304",
      manager_bitrix_user_id: "not null",
      phone_normalized: "not null"
    },
    count: items.length,
    limit,
    events: items
  });
}
