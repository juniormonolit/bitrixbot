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

function collectCallEventIdsFromCaseContext(context: unknown): string[] {
  const ids: string[] = [];
  const o = context && typeof context === "object" ? (context as Record<string, unknown>) : {};
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) ids.push(v.trim());
  };
  add(o.last_call_event_id);
  add(o.created_from_call_event_id);
  return ids;
}

type CallEventDebugRow = {
  id: string;
  crm_activity_id: string | null;
  bitrix_deal_id: string | null;
  deal_url: string | null;
  deal_title: string | null;
  deal_enriched_at: string | null;
  deal_enrichment_error: string | null;
  deal_enrichment_source: string | null;
  raw_payload: unknown;
  occurred_at: string;
};

const CALL_EVENT_SELECT =
  "id, crm_activity_id, bitrix_deal_id, deal_url, deal_title, deal_enriched_at, deal_enrichment_error, deal_enrichment_source, raw_payload, occurred_at";

/** Inspect missed_call_case, related call_events, and notification deliveries (diagnostics). */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const caseId = (url.searchParams.get("caseId") ?? "").trim();
  if (!caseId) {
    return NextResponse.json({ ok: false, error: "caseId required" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  const { data: caseRow, error: caseErr } = await supabase
    .from("missed_call_cases")
    .select(
      "id, phone_normalized, deal_id, deal_url, deal_title, deal_enriched_at, deal_enrichment_error, deal_enrichment_source, context"
    )
    .eq("id", caseId)
    .maybeSingle();

  if (caseErr) {
    return NextResponse.json({ ok: false, error: caseErr.message }, { status: 500 });
  }
  if (!caseRow) {
    return NextResponse.json({ ok: false, error: "case_not_found", caseId }, { status: 404 });
  }

  const c = caseRow as {
    id: string;
    phone_normalized: string;
    deal_id: number | null;
    deal_url: string | null;
    deal_title: string | null;
    deal_enriched_at: string | null;
    deal_enrichment_error: string | null;
    deal_enrichment_source: string | null;
    context: unknown;
  };

  const fromContext = collectCallEventIdsFromCaseContext(c.context);
  const byId = new Map<string, CallEventDebugRow>();

  const { data: byPhone } = await supabase
    .from("call_events")
    .select(CALL_EVENT_SELECT)
    .eq("phone_normalized", c.phone_normalized)
    .order("occurred_at", { ascending: false })
    .limit(20);

  for (const row of (byPhone ?? []) as CallEventDebugRow[]) {
    byId.set(row.id, row);
  }

  for (const id of fromContext) {
    if (byId.has(id)) continue;
    const { data: one } = await supabase.from("call_events").select(CALL_EVENT_SELECT).eq("id", id).maybeSingle();
    if (one) byId.set(id, one as CallEventDebugRow);
  }

  const callEvents = [...byId.values()].sort(
    (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()
  );

  const { data: deliveries, error: delErr } = await supabase
    .from("notification_deliveries")
    .select("id, message_text, delivery_status, created_at")
    .eq("case_id", caseId)
    .order("created_at", { ascending: false })
    .limit(50);

  if (delErr) {
    return NextResponse.json({ ok: false, error: delErr.message }, { status: 500 });
  }

  const deliveryRows = (deliveries ?? []) as {
    id: string;
    message_text: string;
    delivery_status: string;
    created_at: string;
  }[];

  return NextResponse.json({
    ok: true,
    case: {
      id: c.id,
      phone: c.phone_normalized,
      bitrix_deal_id: c.deal_id != null ? String(c.deal_id) : null,
      deal_url: c.deal_url,
      deal_title: c.deal_title,
      deal_enriched_at: c.deal_enriched_at,
      deal_enrichment_error: c.deal_enrichment_error,
      deal_enrichment_source: c.deal_enrichment_source
    },
    callEvents,
    deliveries: deliveryRows.map((d) => {
      const msg = d.message_text ?? "";
      return {
        id: d.id,
        preview: msg.length > 200 ? `${msg.slice(0, 200)}…` : msg,
        message: msg,
        delivery_status: d.delivery_status
      };
    })
  });
}
