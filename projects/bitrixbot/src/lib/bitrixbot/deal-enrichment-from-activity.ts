import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { bitrixCall } from "@/lib/bitrix/client";

const LOG = "[deal-enrichment]";

/** Bitrix CRM: deal owner type (see crm.activity.get OWNER_TYPE_ID). */
const OWNER_TYPE_DEAL = 2;

export type ResolvedDealFromActivity = {
  id: string;
  title: string;
  url: string;
};

export type DealByActivityResolution = {
  activity: Record<string, unknown> | null;
  bindings: unknown[];
  deal: ResolvedDealFromActivity | null;
  reason: string | null;
};

function parseOwnerTypeId(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function asTrimmedString(v: unknown): string {
  if (v === null || v === undefined) return "";
  return String(v).trim();
}

export function buildDealDetailsUrl(dealId: string | number | null | undefined): string {
  if (dealId === null || dealId === undefined) return "";
  const v = String(dealId).trim();
  if (!v) return "";
  const base = env.BITRIX_PORTAL_URL.replace(/\/$/, "");
  return `${base}/crm/deal/details/${v}/`;
}

/**
 * Value for `{{deal_url}}` in templates that prefix with "Сделка:" — full URL or plain "не определена".
 */
function stripLegacyDealLabelPrefix(stored: string): string {
  const t = stored.trim();
  if (/^Сделка:\s*/i.test(t)) {
    return t.replace(/^Сделка:\s*/i, "").trim();
  }
  return t;
}

export function dealUrlForMessageTemplate(
  storedUrl: string | null | undefined,
  dealId: number | null
): string {
  const u = storedUrl?.trim();
  if (u) {
    const normalized = stripLegacyDealLabelPrefix(u);
    return normalized || "не определена";
  }
  return buildDealDetailsUrl(dealId) || "не определена";
}

function extractBindings(activity: Record<string, unknown>): unknown[] {
  const b = activity.BINDINGS;
  if (Array.isArray(b)) return b;
  return [];
}

function extractDealIdFromActivity(activity: Record<string, unknown>): {
  dealId: string | null;
  ownerTypeId: number | null;
  ownerId: string;
} {
  const ownerTypeId = parseOwnerTypeId(activity.OWNER_TYPE_ID);
  const ownerId = asTrimmedString(activity.OWNER_ID);

  if (ownerTypeId === OWNER_TYPE_DEAL && ownerId) {
    return { dealId: ownerId, ownerTypeId, ownerId };
  }

  const bindings = extractBindings(activity);
  for (const raw of bindings) {
    if (!raw || typeof raw !== "object") continue;
    const b = raw as Record<string, unknown>;
    if (parseOwnerTypeId(b.OWNER_TYPE_ID) === OWNER_TYPE_DEAL) {
      const oid = asTrimmedString(b.OWNER_ID);
      if (oid) return { dealId: oid, ownerTypeId, ownerId };
    }
  }

  return { dealId: null, ownerTypeId, ownerId };
}

async function fetchDealTitle(dealId: string): Promise<string> {
  const idNum = Number(dealId);
  if (!Number.isFinite(idNum)) return "";
  try {
    const res = await bitrixCall<{ item?: Record<string, unknown> }>("crm.item.get", {
      entityTypeId: OWNER_TYPE_DEAL,
      id: idNum
    });
    const title = res?.item?.title;
    return typeof title === "string" ? title.trim() : "";
  } catch {
    return "";
  }
}

/**
 * Resolve deal id/title/url from a CRM timeline activity id (crm.activity.get).
 * Does not throw on missing activity or non-deal owner (returns reason instead).
 */
export async function resolveDealByCrmActivityId(activityId: string): Promise<DealByActivityResolution> {
  const trimmed = activityId.trim();
  if (!trimmed) {
    return { activity: null, bindings: [], deal: null, reason: "empty_activity_id" };
  }

  const idNum = Number(trimmed);
  if (!Number.isFinite(idNum)) {
    return { activity: null, bindings: [], deal: null, reason: "invalid_activity_id" };
  }

  console.log(`${LOG} start crmActivityId=${trimmed}`);

  let activity: Record<string, unknown>;
  try {
    activity = (await bitrixCall<Record<string, unknown>>("crm.activity.get", {
      id: idNum
    })) as Record<string, unknown>;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${LOG} deal_not_found crmActivityId=${trimmed} reason=activity_fetch_failed:${msg}`);
    return { activity: null, bindings: [], deal: null, reason: `activity_fetch_failed:${msg}` };
  }

  const bindings = extractBindings(activity);
  const ownerTypeId = parseOwnerTypeId(activity.OWNER_TYPE_ID);
  const ownerId = asTrimmedString(activity.OWNER_ID);
  console.log(
    `${LOG} activity_found ownerTypeId=${ownerTypeId ?? "null"} ownerId=${ownerId || "empty"} bindings=${JSON.stringify(bindings).slice(0, 500)}`
  );

  const { dealId } = extractDealIdFromActivity(activity);
  if (!dealId) {
    const reason =
      ownerTypeId === OWNER_TYPE_DEAL
        ? "deal_owner_missing_id"
        : `deal_not_found_for_activity:ownerTypeId=${ownerTypeId ?? "null"}`;
    console.log(`${LOG} deal_not_found crmActivityId=${trimmed} reason=${reason}`);
    return { activity, bindings, deal: null, reason };
  }

  const title = (await fetchDealTitle(dealId)) || `Сделка #${dealId}`;
  const url = buildDealDetailsUrl(dealId);
  console.log(`${LOG} deal_found dealId=${dealId} title=${title.slice(0, 120)}`);

  return {
    activity,
    bindings,
    deal: { id: dealId, title, url },
    reason: null
  };
}

export type CallEventDealEnrichmentRow = {
  id: string;
  bitrix_deal_id: string | null;
  crm_activity_id: string | null;
  deal_title: string | null;
  deal_url: string | null;
  deal_enriched_at: string | null;
  deal_enrichment_error: string | null;
};

function shouldRunDealEnrichment(ce: CallEventDealEnrichmentRow): boolean {
  if (ce.bitrix_deal_id?.trim()) return false;
  if (!ce.crm_activity_id?.trim()) return false;
  if (ce.deal_enriched_at) return false;
  return true;
}

/**
 * If the call event has CRM activity but no deal id, resolve deal via Bitrix and persist on `call_events`.
 * Never throws; logs failures and sets `deal_enrichment_error`.
 */
export async function enrichCallEventDealIfNeeded(
  supabase: SupabaseClient,
  ce: CallEventDealEnrichmentRow
): Promise<CallEventDealEnrichmentRow> {
  if (!shouldRunDealEnrichment(ce)) return ce;

  const crmActivityId = ce.crm_activity_id!.trim();
  const now = new Date().toISOString();

  try {
    const resolution = await resolveDealByCrmActivityId(crmActivityId);

    if (resolution.deal) {
      const patch = {
        bitrix_deal_id: resolution.deal.id,
        deal_title: resolution.deal.title,
        deal_url: resolution.deal.url,
        deal_enriched_at: now,
        deal_enrichment_error: null as string | null
      };
      const { error } = await supabase.from("call_events").update(patch).eq("id", ce.id);
      if (error) {
        console.log(`${LOG} persist_failed callEventId=${ce.id} err=${error.message}`);
      } else {
        console.log(`${LOG} saved callEventId=${ce.id} dealId=${resolution.deal.id}`);
      }
      return { ...ce, ...patch };
    }

    const reason = resolution.reason ?? "deal_not_found_for_activity";
    const patch = {
      deal_enriched_at: now,
      deal_enrichment_error: reason
    };
    const { error } = await supabase.from("call_events").update(patch).eq("id", ce.id);
    if (error) {
      console.log(`${LOG} persist_failed callEventId=${ce.id} err=${error.message}`);
    }
    return { ...ce, ...patch };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${LOG} deal_not_found crmActivityId=${crmActivityId} reason=enrichment_exception:${msg}`);
    const patch = {
      deal_enriched_at: now,
      deal_enrichment_error: `enrichment_exception:${msg}`
    };
    const { error } = await supabase.from("call_events").update(patch).eq("id", ce.id);
    if (error) {
      console.log(`${LOG} persist_failed callEventId=${ce.id} err=${error.message}`);
    }
    return { ...ce, ...patch };
  }
}
