import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { loadCallEventsForCase } from "@/src/lib/bitrixbot/case-call-events";
import { redactSecretsForDebug } from "@/src/lib/bitrixbot/redact-webhook-payload";
import { normalizeStoredDealUrl } from "@/src/lib/bitrixbot/deal-enrichment-from-activity";
import { explainMissedCallAlertRulesForCase } from "@/src/lib/bitrixbot/prepare-notifications-for-missed-call-case";
import { voximplantPayloadSummary } from "@/src/lib/bitrixbot/voximplant-inbound-missed";

function isAuthorized(req: Request): boolean {
  const header = req.headers.get("x-debug-secret") ?? "";
  const url = new URL(req.url);
  const query = url.searchParams.get("secret") ?? "";
  const secret = header || query;
  return Boolean(secret && secret === env.DEBUG_SECRET);
}

/** Inspect missed_call_case, related call_events, and notification deliveries (diagnostics). */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const caseId = (url.searchParams.get("caseId") ?? "").trim();
  const explainRules = (url.searchParams.get("explainRules") ?? "").trim() === "1";
  if (!caseId) {
    return NextResponse.json({ ok: false, error: "caseId required" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();

  const { data: caseRow, error: caseErr } = await supabase
    .from("missed_call_cases")
    .select(
      "id, phone_normalized, deal_id, deal_url, deal_title, deal_enriched_at, deal_enrichment_error, deal_enrichment_source, manager_bitrix_user_id, manager_name, context"
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
    manager_bitrix_user_id: string | null;
    manager_name: string | null;
    context: unknown;
  };

  const callEventRows = await loadCallEventsForCase(
    supabase,
    { phone_normalized: c.phone_normalized, context: c.context },
    50
  );

  const callEvents = callEventRows.map((ev) => ({
    id: ev.id,
    status: ev.status,
    manager_bitrix_user_id: ev.manager_bitrix_user_id,
    call_direction: ev.call_direction,
    call_type_raw: ev.call_type_raw,
    crm_activity_id: ev.crm_activity_id,
    bitrix_deal_id: ev.bitrix_deal_id,
    deal_url: normalizeStoredDealUrl(ev.deal_url),
    deal_title: ev.deal_title,
    deal_enriched_at: ev.deal_enriched_at,
    deal_enrichment_error: ev.deal_enrichment_error,
    deal_enrichment_source: ev.deal_enrichment_source,
    occurred_at: ev.occurred_at,
    call_duration_seconds: ev.call_duration_seconds ?? null,
    failed_code: ev.failed_code ?? null,
    payload_summary: voximplantPayloadSummary(ev.raw_payload),
    raw_payload_safe: redactSecretsForDebug(ev.raw_payload)
  }));

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

  const alertRuleExplanation = explainRules
    ? await explainMissedCallAlertRulesForCase(caseId).catch((e: unknown) => ({
        explainError: e instanceof Error ? e.message : String(e)
      }))
    : undefined;

  return NextResponse.json({
    ok: true,
    case: {
      id: c.id,
      phone: c.phone_normalized,
      manager_bitrix_user_id: c.manager_bitrix_user_id,
      manager_name: c.manager_name,
      context: c.context,
      bitrix_deal_id: c.deal_id != null ? String(c.deal_id) : null,
      deal_url: normalizeStoredDealUrl(c.deal_url),
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
    }),
    ...(alertRuleExplanation !== undefined ? { alertRuleExplanation } : {})
  });
}
