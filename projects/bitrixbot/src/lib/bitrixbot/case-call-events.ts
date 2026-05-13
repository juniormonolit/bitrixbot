import type { SupabaseClient } from "@supabase/supabase-js";

export function collectCallEventIdsFromCaseContext(context: unknown): string[] {
  const ids: string[] = [];
  const o = context && typeof context === "object" ? (context as Record<string, unknown>) : {};
  const add = (v: unknown) => {
    if (typeof v === "string" && v.trim()) ids.push(v.trim());
  };
  add(o.last_call_event_id);
  add(o.created_from_call_event_id);
  return ids;
}

export type CaseCallEventRow = {
  id: string;
  status: string | null;
  call_direction: string | null;
  call_type_raw: string | null;
  call_duration_seconds: number | null;
  failed_code: string | null;
  crm_activity_id: string | null;
  bitrix_deal_id: string | null;
  phone_normalized: string | null;
  deal_url: string | null;
  deal_title: string | null;
  deal_enriched_at: string | null;
  deal_enrichment_error: string | null;
  deal_enrichment_source: string | null;
  raw_payload: unknown;
  occurred_at: string;
};

const SELECT_FIELDS =
  "id, status, call_direction, call_type_raw, call_duration_seconds, failed_code, crm_activity_id, bitrix_deal_id, phone_normalized, deal_url, deal_title, deal_enriched_at, deal_enrichment_error, deal_enrichment_source, raw_payload, occurred_at";

/** Load call_events linked to a missed_call_case (context ids + recent same phone). */
export async function loadCallEventsForCase(
  supabase: SupabaseClient,
  caseRow: { phone_normalized: string; context: unknown },
  phoneLimit = 50
): Promise<CaseCallEventRow[]> {
  const fromContext = collectCallEventIdsFromCaseContext(caseRow.context);
  const byId = new Map<string, CaseCallEventRow>();

  const { data: byPhone } = await supabase
    .from("call_events")
    .select(SELECT_FIELDS)
    .eq("phone_normalized", caseRow.phone_normalized)
    .order("occurred_at", { ascending: false })
    .limit(phoneLimit);

  for (const row of (byPhone ?? []) as CaseCallEventRow[]) {
    byId.set(row.id, row);
  }

  for (const id of fromContext) {
    if (byId.has(id)) continue;
    const { data: one } = await supabase.from("call_events").select(SELECT_FIELDS).eq("id", id).maybeSingle();
    if (one) byId.set(id, one as CaseCallEventRow);
  }

  return [...byId.values()].sort(
    (a, b) => new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime()
  );
}
