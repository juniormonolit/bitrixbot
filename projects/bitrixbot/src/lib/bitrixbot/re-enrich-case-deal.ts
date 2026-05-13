import type { SupabaseClient } from "@supabase/supabase-js";
import {
  enrichCallEventDealPipeline,
  buildDealDetailsUrl,
  normalizeStoredDealUrl,
  isUsableCrmActivityId,
  dealUrlForMessageTemplate,
  type CallEventDealEnrichmentRow
} from "@/src/lib/bitrixbot/deal-enrichment-from-activity";
import { loadCallEventsForCase, type CaseCallEventRow } from "@/src/lib/bitrixbot/case-call-events";

const CASE_FIELDS =
  "id, phone_normalized, context, deal_id, deal_url, deal_title, deal_enriched_at, deal_enrichment_error, deal_enrichment_source";

function toPipelineRow(ev: CaseCallEventRow): CallEventDealEnrichmentRow {
  return {
    id: ev.id,
    bitrix_deal_id: ev.bitrix_deal_id,
    crm_activity_id: ev.crm_activity_id,
    phone_normalized: ev.phone_normalized,
    deal_title: ev.deal_title,
    deal_url: ev.deal_url,
    deal_enriched_at: ev.deal_enriched_at,
    deal_enrichment_error: ev.deal_enrichment_error,
    deal_enrichment_source: ev.deal_enrichment_source
  };
}

function sourceRank(source: string | null | undefined): number {
  if (source === "crm_activity") return 3;
  if (source === "phone_lookup") return 2;
  if (source === "existing_call_event_deal_id") return 1;
  return 0;
}

function snapshotCase(c: Record<string, unknown>) {
  return {
    id: c.id,
    phone: c.phone_normalized,
    bitrix_deal_id: c.deal_id != null ? String(c.deal_id) : null,
    deal_url: c.deal_url,
    deal_title: c.deal_title,
    deal_enriched_at: c.deal_enriched_at,
    deal_enrichment_error: c.deal_enrichment_error,
    deal_enrichment_source: c.deal_enrichment_source
  };
}

export type ReEnrichCaseDealResult = {
  ok: boolean;
  caseId: string;
  beforeCase: unknown;
  afterCase: unknown;
  enrichedCallEvents: Array<{ id: string; before: unknown; after: unknown }>;
  chosenDeal: {
    dealId: string;
    dealUrl: string;
    dealTitle: string;
    deal_enrichment_source: string | null;
    fromCallEventId: string;
  } | null;
  errors: string[];
};

/**
 * Re-run call_event deal enrichment for a case’s related events, pick the best deal, update missed_call_cases.
 */
export async function reEnrichMissedCallCaseDeal(
  supabase: SupabaseClient,
  caseId: string,
  opts?: { phoneEventLimit?: number }
): Promise<ReEnrichCaseDealResult> {
  const errors: string[] = [];
  const phoneLimit = Math.min(100, Math.max(10, opts?.phoneEventLimit ?? 50));

  const { data: caseRow, error: cErr } = await supabase
    .from("missed_call_cases")
    .select(CASE_FIELDS)
    .eq("id", caseId)
    .maybeSingle();

  if (cErr) {
    return {
      ok: false,
      caseId,
      beforeCase: null,
      afterCase: null,
      enrichedCallEvents: [],
      chosenDeal: null,
      errors: [cErr.message]
    };
  }
  if (!caseRow) {
    return {
      ok: false,
      caseId,
      beforeCase: null,
      afterCase: null,
      enrichedCallEvents: [],
      chosenDeal: null,
      errors: ["case_not_found"]
    };
  }

  const cr = caseRow as {
    id: string;
    phone_normalized: string;
    context: unknown;
    deal_id: number | null;
    deal_url: string | null;
    deal_title: string | null;
    deal_enriched_at: string | null;
    deal_enrichment_error: string | null;
    deal_enrichment_source: string | null;
  };

  const beforeCase = snapshotCase(caseRow as Record<string, unknown>);
  const events = await loadCallEventsForCase(
    supabase,
    { phone_normalized: cr.phone_normalized, context: cr.context },
    phoneLimit
  );

  const enrichedCallEvents: ReEnrichCaseDealResult["enrichedCallEvents"] = [];

  for (const ev of events) {
    if (ev.bitrix_deal_id?.trim()) continue;
    const beforeEv = {
      id: ev.id,
      crm_activity_id: ev.crm_activity_id,
      bitrix_deal_id: ev.bitrix_deal_id,
      deal_url: ev.deal_url,
      deal_title: ev.deal_title,
      deal_enriched_at: ev.deal_enriched_at,
      deal_enrichment_source: ev.deal_enrichment_source
    };
    try {
      await enrichCallEventDealPipeline(supabase, toPipelineRow(ev), { force: true });
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      errors.push(`event ${ev.id}: ${m}`);
    }
    const { data: fresh, error: fErr } = await supabase
      .from("call_events")
      .select(
        "id, crm_activity_id, bitrix_deal_id, deal_url, deal_title, deal_enriched_at, deal_enrichment_error, deal_enrichment_source"
      )
      .eq("id", ev.id)
      .maybeSingle();
    if (fErr) errors.push(`reload ${ev.id}: ${fErr.message}`);
    enrichedCallEvents.push({ id: ev.id, before: beforeEv, after: fresh });
  }

  const reloadEvents = await loadCallEventsForCase(
    supabase,
    { phone_normalized: cr.phone_normalized, context: cr.context },
    phoneLimit
  );

  const candidates: Array<{
    eventId: string;
    dealId: string;
    dealUrl: string;
    dealTitle: string;
    source: string | null;
    occurredAt: string;
  }> = [];

  for (const ev of reloadEvents) {
    const did = ev.bitrix_deal_id?.trim();
    if (!did) continue;
    const url = normalizeStoredDealUrl(ev.deal_url) || buildDealDetailsUrl(did);
    if (!url.startsWith("http")) continue;
    candidates.push({
      eventId: ev.id,
      dealId: did,
      dealUrl: url,
      dealTitle: ev.deal_title?.trim() || "",
      source: ev.deal_enrichment_source,
      occurredAt: ev.occurred_at
    });
  }

  candidates.sort((a, b) => {
    const sr = sourceRank(b.source) - sourceRank(a.source);
    if (sr !== 0) return sr;
    return new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
  });

  const chosen = candidates[0] ?? null;
  const now = new Date().toISOString();

  if (chosen) {
    const dealIdNum = Number(chosen.dealId);
    const patch = {
      deal_id: Number.isFinite(dealIdNum) ? Math.trunc(dealIdNum) : null,
      deal_url: chosen.dealUrl,
      deal_title: chosen.dealTitle || null,
      deal_enriched_at: now,
      deal_enrichment_error: null as string | null,
      deal_enrichment_source: chosen.source ?? "crm_activity"
    };
    const { error: uErr } = await supabase.from("missed_call_cases").update(patch).eq("id", caseId);
    if (uErr) errors.push(`case_update:${uErr.message}`);
  } else {
    const patch: Record<string, unknown> = {
      deal_enriched_at: now,
      deal_enrichment_error: "re_enrich_no_deal_found",
      deal_enrichment_source: "not_found"
    };
    if (cr.deal_id != null) {
      patch.deal_url = buildDealDetailsUrl(cr.deal_id) || null;
    } else {
      patch.deal_id = null;
      patch.deal_url = null;
      patch.deal_title = null;
    }
    const { error: uErr } = await supabase.from("missed_call_cases").update(patch).eq("id", caseId);
    if (uErr) errors.push(`case_update_clear:${uErr.message}`);
  }

  const { data: after } = await supabase.from("missed_call_cases").select(CASE_FIELDS).eq("id", caseId).maybeSingle();

  return {
    ok: errors.length === 0,
    caseId,
    beforeCase,
    afterCase: after ? snapshotCase(after as Record<string, unknown>) : null,
    enrichedCallEvents,
    chosenDeal: chosen
      ? {
          dealId: chosen.dealId,
          dealUrl: chosen.dealUrl,
          dealTitle: chosen.dealTitle,
          deal_enrichment_source: chosen.source,
          fromCallEventId: chosen.eventId
        }
      : null,
    errors
  };
}

export function openCaseNeedsDealBackfill(c: {
  deal_id: number | null;
  deal_url: string | null;
  deal_enriched_at: string | null;
}): boolean {
  if (c.deal_id == null) return true;
  if (!normalizeStoredDealUrl(c.deal_url)) return true;
  if (c.deal_enriched_at == null) return true;
  return false;
}

/**
 * Lightweight pre-send refresh: only when case deal fields look empty/bad and a related call_event has a usable CRM activity id.
 */
export async function maybeReenrichCaseBeforeSend(
  supabase: SupabaseClient,
  caseId: string
): Promise<{ attempted: boolean; chosen: boolean }> {
  const { data: c } = await supabase
    .from("missed_call_cases")
    .select("id, deal_id, deal_url, phone_normalized, context")
    .eq("id", caseId)
    .maybeSingle();
  if (!c) return { attempted: false, chosen: false };

  const row = c as {
    deal_id: number | null;
    deal_url: string | null;
    phone_normalized: string;
    context: unknown;
  };

  const nu = normalizeStoredDealUrl(row.deal_url);
  const built = row.deal_id != null ? buildDealDetailsUrl(row.deal_id) : "";
  const hasGoodDeal =
    row.deal_id != null && ((nu != null && nu.startsWith("http")) || built.startsWith("http"));
  if (hasGoodDeal) return { attempted: false, chosen: false };

  const evs = await loadCallEventsForCase(
    supabase,
    { phone_normalized: row.phone_normalized, context: row.context },
    30
  );
  const enrichable = evs.some((e) => !e.bitrix_deal_id?.trim() && isUsableCrmActivityId(e.crm_activity_id));
  if (!enrichable) return { attempted: false, chosen: false };

  const res = await reEnrichMissedCallCaseDeal(supabase, caseId, { phoneEventLimit: 30 });
  return { attempted: true, chosen: Boolean(res.chosenDeal) };
}

/** If case now has a real deal URL, replace placeholder “Сделка: не определена” lines in a pending delivery message. */
export async function refreshPendingDeliveryMessageDealLine(
  supabase: SupabaseClient,
  deliveryId: string,
  caseId: string
): Promise<{ updated: boolean }> {
  const { data: c } = await supabase.from("missed_call_cases").select("deal_id, deal_url").eq("id", caseId).maybeSingle();
  if (!c) return { updated: false };
  const typed = c as { deal_id: number | null; deal_url: string | null };
  const line = dealUrlForMessageTemplate(typed.deal_url, typed.deal_id);
  if (line === "не определена") return { updated: false };

  const { data: d } = await supabase.from("notification_deliveries").select("message_text").eq("id", deliveryId).maybeSingle();
  const msg = d?.message_text ?? "";
  if (!msg.includes("не определена")) return { updated: false };

  let next = msg.replace(/Сделка:\s*Сделка:\s*не определена/gi, `Сделка: ${line}`);
  next = next.replace(/Сделка:\s*не определена/gi, `Сделка: ${line}`);
  if (next === msg) return { updated: false };

  const { error } = await supabase.from("notification_deliveries").update({ message_text: next }).eq("id", deliveryId);
  if (error) return { updated: false };
  return { updated: true };
}
