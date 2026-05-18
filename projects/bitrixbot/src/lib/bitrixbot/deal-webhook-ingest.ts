import type { SupabaseClient } from "@supabase/supabase-js";
import type { NormalizedDealEvent } from "@/lib/bitrix/deal-normalize";
import { normalizePhoneForAnalytics } from "@/lib/bitrix/phone-normalize";

type JsonObject = Record<string, unknown>;

function getObj(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  return {};
}

function pickStr(v: unknown): string | null {
  if (typeof v === "string") {
    const t = v.trim();
    return t || null;
  }
  if (typeof v === "number") return String(v);
  return null;
}

function parseUpdatedAtSource(v: unknown): string | null {
  const s = pickStr(v);
  if (!s) return null;
  const t = new Date(s).getTime();
  if (!Number.isFinite(t)) return null;
  return new Date(t).toISOString();
}

export function normalizePhonesFromExtendedPayload(phones: unknown): string[] {
  if (!Array.isArray(phones)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of phones) {
    const n = normalizePhoneForAnalytics(pickStr(raw));
    if (!n || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

const EXTENDED_DEAL_EVENTS = new Set([
  "deal_created",
  "deal_updated",
  "deal_deleted",
  "deal_archived",
  "deal_stage_changed"
]);

export function isExtendedDealBusinessWebhookPayload(payload: unknown): boolean {
  const root = getObj(payload);
  const ev = (pickStr(root.event) ?? "").toLowerCase();
  if (!EXTENDED_DEAL_EVENTS.has(ev)) return false;
  return Boolean(pickStr(root.deal_id) ?? pickStr(root.DEAL_ID));
}

export async function upsertDealRowFromStandardEvent(
  supabase: SupabaseClient,
  normalized: NormalizedDealEvent
): Promise<void> {
  const id = normalized.bitrix_deal_id.trim();
  if (!id) return;

  const snap = {
    lastInbound: "ONCRMDEALADD_OR_UPDATE",
    stage_id: normalized.stage_id,
    category_id: normalized.category_id,
    assigned_by_id: normalized.assigned_by_id
  };

  const { error } = await supabase.from("deals").upsert(
    {
      bitrix_deal_id: id,
      title: normalized.title,
      stage_id: normalized.stage_id,
      category_id: normalized.category_id,
      assigned_by_id: normalized.assigned_by_id,
      contact_id: null,
      company_id: null,
      is_archived: false,
      updated_at_source: normalized.occurred_at,
      raw_snapshot: snap as unknown as Record<string, unknown>
    },
    { onConflict: "bitrix_deal_id" }
  );

  if (error) throw new Error(error.message);
}

export async function markDealArchived(supabase: SupabaseClient, bitrixDealId: string): Promise<void> {
  const id = bitrixDealId.trim();
  if (!id) return;

  const { error: delDealPhones } = await supabase.from("deal_phone_index").delete().eq("bitrix_deal_id", id);
  if (delDealPhones) throw new Error(delDealPhones.message);

  const { error: delCrmByDeal } = await supabase.from("crm_phone_index").delete().eq("bitrix_deal_id", id);
  if (delCrmByDeal) throw new Error(delCrmByDeal.message);

  const { error: delCrmDealEntity } = await supabase
    .from("crm_phone_index")
    .delete()
    .eq("entity_type", "deal")
    .eq("entity_id", id);
  if (delCrmDealEntity) throw new Error(delCrmDealEntity.message);

  const { error } = await supabase
    .from("deals")
    .update({
      is_archived: true,
      updated_at_source: new Date().toISOString(),
      raw_snapshot: { archivedAt: new Date().toISOString() }
    })
    .eq("bitrix_deal_id", id);

  if (error) throw new Error(error.message);
}

/**
 * Robot/BP extended payload: full deal snapshot + phones → deals + indexes + deal_events row.
 */
export async function ingestExtendedDealWebhookPayload(
  supabase: SupabaseClient,
  payload: unknown
): Promise<{ dealId: string; event: string; phonesIndexed: number }> {
  const root = getObj(payload);
  const eventRaw = (pickStr(root.event) ?? "").toLowerCase();
  const dealId = pickStr(root.deal_id) ?? pickStr(root.DEAL_ID);
  if (!dealId) throw new Error("extended_deal_missing_deal_id");

  const phones = normalizePhonesFromExtendedPayload(root.phones);
  const updatedAtSource = parseUpdatedAtSource(root.updated_at) ?? new Date().toISOString();

  const rawExtra = getObj(root.raw);
  const mergedSnapshot = {
    extendedEvent: eventRaw,
    payloadKeys: Object.keys(root).slice(0, 40),
    ...(Object.keys(rawExtra).length ? { robotRaw: rawExtra } : {})
  };

  if (eventRaw === "deal_deleted" || eventRaw === "deal_archived") {
    const { error: evErr } = await supabase.from("deal_events").insert({
      event_name: eventRaw,
      bitrix_deal_id: dealId,
      stage_id: null,
      category_id: null,
      assigned_by_id: null,
      created_by_id: null,
      title: null,
      opportunity: null,
      currency: null,
      is_new: false,
      occurred_at: updatedAtSource,
      raw_payload: payload as Record<string, unknown>
    });
    if (evErr) throw new Error(evErr.message);

    await markDealArchived(supabase, dealId);
    return { dealId, event: eventRaw, phonesIndexed: 0 };
  }

  const title = pickStr(root.title);
  const stage_id = pickStr(root.stage_id);
  const category_id = pickStr(root.category_id);
  const assigned_by_id = pickStr(root.assigned_by_id);
  const contact_id = pickStr(root.contact_id);
  const company_id = pickStr(root.company_id);
  const stage_semantic_id = pickStr(root.stage_semantic_id);

  const { error: upsertErr } = await supabase.from("deals").upsert(
    {
      bitrix_deal_id: dealId,
      title,
      stage_id,
      category_id,
      assigned_by_id,
      contact_id,
      company_id,
      stage_semantic_id,
      is_archived: false,
      updated_at_source: updatedAtSource,
      raw_snapshot: mergedSnapshot as unknown as Record<string, unknown>
    },
    { onConflict: "bitrix_deal_id" }
  );
  if (upsertErr) throw new Error(upsertErr.message);

  const isNew = eventRaw === "deal_created";
  const { error: evErr } = await supabase.from("deal_events").insert({
    event_name: eventRaw,
    bitrix_deal_id: dealId,
    stage_id,
    category_id,
    assigned_by_id,
    created_by_id: null,
    title,
    opportunity: null,
    currency: null,
    is_new: isNew,
    occurred_at: updatedAtSource,
    raw_payload: payload as Record<string, unknown>
  });
  if (evErr) throw new Error(evErr.message);

  const { error: wipeDealIdx } = await supabase.from("deal_phone_index").delete().eq("bitrix_deal_id", dealId);
  if (wipeDealIdx) throw new Error(wipeDealIdx.message);

  const { error: wipeCrmDeal } = await supabase
    .from("crm_phone_index")
    .delete()
    .eq("entity_type", "deal")
    .eq("entity_id", dealId);
  if (wipeCrmDeal) throw new Error(wipeCrmDeal.message);

  let phonesIndexed = 0;
  for (const phone_normalized of phones) {
    const { error: dpiErr } = await supabase.from("deal_phone_index").insert({
      phone_normalized,
      bitrix_deal_id: dealId
    });
    if (dpiErr) throw new Error(dpiErr.message);

    const { error: crmDealErr } = await supabase.from("crm_phone_index").upsert(
      {
        phone_normalized,
        entity_type: "deal",
        entity_id: dealId,
        bitrix_deal_id: dealId
      },
      { onConflict: "phone_normalized,entity_type,entity_id" }
    );
    if (crmDealErr) throw new Error(crmDealErr.message);
    phonesIndexed++;
  }

  if (contact_id) {
    for (const phone_normalized of phones) {
      const { error: crmCErr } = await supabase.from("crm_phone_index").upsert(
        {
          phone_normalized,
          entity_type: "contact",
          entity_id: contact_id,
          bitrix_deal_id: dealId
        },
        { onConflict: "phone_normalized,entity_type,entity_id" }
      );
      if (crmCErr) throw new Error(crmCErr.message);
    }
  }

  if (company_id) {
    for (const phone_normalized of phones) {
      const { error: crmCoErr } = await supabase.from("crm_phone_index").upsert(
        {
          phone_normalized,
          entity_type: "company",
          entity_id: company_id,
          bitrix_deal_id: dealId
        },
        { onConflict: "phone_normalized,entity_type,entity_id" }
      );
      if (crmCoErr) throw new Error(crmCoErr.message);
    }
  }

  return { dealId, event: eventRaw, phonesIndexed };
}
