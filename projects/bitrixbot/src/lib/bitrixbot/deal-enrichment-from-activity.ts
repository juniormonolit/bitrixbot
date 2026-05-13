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

export type CallEventDealEnrichmentRow = {
  id: string;
  bitrix_deal_id: string | null;
  crm_activity_id: string | null;
  /** Used for phone fallback when activity id is unusable or yields no deal. */
  phone_normalized?: string | null;
  deal_title: string | null;
  deal_url: string | null;
  deal_enriched_at: string | null;
  deal_enrichment_error: string | null;
  deal_enrichment_source: string | null;
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

export async function fetchDealTitle(dealId: string): Promise<string> {
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

/** True when CRM activity id is present and can be passed to crm.activity.get. */
export function isUsableCrmActivityId(id: string | null | undefined): boolean {
  if (id == null) return false;
  const t = String(id).trim();
  if (!t) return false;
  const n = Number(t);
  if (!Number.isFinite(n) || n === 0) return false;
  return true;
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
  if (!Number.isFinite(idNum) || idNum === 0) {
    return { activity: null, bindings: [], deal: null, reason: "crm_activity_id_is_zero" };
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

function asNumberArray(v: unknown): number[] {
  if (!Array.isArray(v)) return [];
  const out: number[] = [];
  for (const x of v) {
    const n = Number(x);
    if (Number.isFinite(n) && n > 0) out.push(Math.trunc(n));
  }
  return out;
}

function parseCreatedMs(it: Record<string, unknown>): number {
  const ct = it.createdTime ?? it.DATE_CREATE ?? it.dateCreate;
  if (typeof ct === "string") {
    const t = new Date(ct).getTime();
    if (Number.isFinite(t)) return t;
  }
  const id = Number(it.id);
  return Number.isFinite(id) ? id : 0;
}

function isDealOpenish(it: Record<string, unknown>): boolean {
  const sem = String(it.stageSemanticId ?? "");
  if (sem === "L" || sem === "W") return false;
  const o = it.opened;
  if (o === "N" || o === false || o === 0 || o === "0") return false;
  return true;
}

async function listDealsWithFilterVariants(
  filters: Record<string, unknown>[]
): Promise<Record<string, unknown>[]> {
  for (const filter of filters) {
    try {
      const res = await bitrixCall<{ items?: Record<string, unknown>[] }>("crm.item.list", {
        entityTypeId: OWNER_TYPE_DEAL,
        filter,
        select: ["id", "title", "createdTime", "stageSemanticId", "opened"],
        order: { id: "DESC" },
        start: 0
      });
      const items = Array.isArray(res?.items) ? res.items : [];
      if (items.length > 0) return items;
    } catch {
      // try next filter shape
    }
  }
  return [];
}

function contactDealFilterVariants(contactId: number): Record<string, unknown>[] {
  return [
    { contactId: contactId },
    { CONTACT_ID: contactId },
    { "@contactIds": [contactId] }
  ];
}

function companyDealFilterVariants(companyId: number): Record<string, unknown>[] {
  return [
    { companyId: companyId },
    { COMPANY_ID: companyId },
    { "@companyIds": [companyId] }
  ];
}

/**
 * Find newest “open-ish” deal linked to duplicate search hits for a phone number.
 */
export async function resolveDealByPhoneLookup(phoneNormalized: string): Promise<ResolvedDealFromActivity | null> {
  const base = phoneNormalized.trim();
  if (!base) return null;

  const values = [base];
  const digits = base.replace(/\D/g, "");
  if (digits.length >= 10 && !base.includes("+")) {
    values.push(`+${digits}`);
  }

  try {
    const dup = await bitrixCall<Record<string, unknown>>("crm.duplicate.findbycomm", {
      type: "PHONE",
      values: values.slice(0, 20)
    });

    const contactIds = asNumberArray(dup.CONTACT).slice(0, 8);
    const companyIds = asNumberArray(dup.COMPANY).slice(0, 8);

    const byId = new Map<number, Record<string, unknown>>();

    for (const cid of contactIds) {
      const items = await listDealsWithFilterVariants(contactDealFilterVariants(cid));
      for (const it of items) {
        const id = Number(it.id);
        if (Number.isFinite(id) && !byId.has(id)) byId.set(id, it);
      }
    }
    for (const cid of companyIds) {
      const items = await listDealsWithFilterVariants(companyDealFilterVariants(cid));
      for (const it of items) {
        const id = Number(it.id);
        if (Number.isFinite(id) && !byId.has(id)) byId.set(id, it);
      }
    }

    const candidates = [...byId.values()];
    if (candidates.length === 0) {
      console.log(`${LOG} phone_lookup no_deals phone=${base.slice(0, 32)}`);
      return null;
    }

    const openish = candidates.filter(isDealOpenish);
    const pool = openish.length > 0 ? openish : candidates;
    pool.sort((a, b) => parseCreatedMs(b) - parseCreatedMs(a));
    const best = pool[0];
    const id = String(best.id ?? "").trim();
    if (!id) return null;

    const title =
      (typeof best.title === "string" && best.title.trim()) || (await fetchDealTitle(id)) || `Сделка #${id}`;
    const url = buildDealDetailsUrl(id);
    console.log(`${LOG} phone_lookup deal_found dealId=${id} title=${title.slice(0, 80)}`);
    return { id, title, url };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`${LOG} phone_lookup error phone=${base.slice(0, 32)} err=${msg}`);
    return null;
  }
}

async function persistSkipReason(
  supabase: SupabaseClient,
  ce: CallEventDealEnrichmentRow,
  now: string,
  reason: string,
  source: string
): Promise<{ error: { message: string } | null }> {
  const { error } = await supabase
    .from("call_events")
    .update({
      deal_enriched_at: now,
      deal_enrichment_error: reason,
      deal_enrichment_source: source
    })
    .eq("id", ce.id);
  return { error };
}

/**
 * Full deal enrichment: existing column → CRM activity → phone duplicate lookup.
 * Sets `deal_enriched_at` once when the pipeline finishes (success or terminal failure).
 */
export async function enrichCallEventDealPipeline(
  supabase: SupabaseClient,
  ce: CallEventDealEnrichmentRow
): Promise<CallEventDealEnrichmentRow> {
  if (ce.deal_enriched_at) {
    return ce;
  }

  const now = new Date().toISOString();
  const beforeDealId = ce.bitrix_deal_id?.trim() || null;
  const crmRaw = ce.crm_activity_id?.trim() ?? "";

  try {
    if (ce.bitrix_deal_id?.trim()) {
      const id = ce.bitrix_deal_id.trim();
      const url = ce.deal_url?.trim() || buildDealDetailsUrl(id);
      let title = ce.deal_title?.trim() || "";
      if (!title) title = (await fetchDealTitle(id)) || `Сделка #${id}`;
      const patch = {
        bitrix_deal_id: id,
        deal_url: url,
        deal_title: title,
        deal_enrichment_source: "existing_call_event_deal_id",
        deal_enriched_at: now,
        deal_enrichment_error: null as string | null
      };
      const { error } = await supabase.from("call_events").update(patch).eq("id", ce.id);
      if (error) console.log(`${LOG} persist_failed callEventId=${ce.id} err=${error.message}`);
      const merged = { ...ce, ...patch };
      console.log(
        `${LOG} pipeline callEventId=${ce.id} crmActivityId=${crmRaw || "null"} beforeDealId=${beforeDealId ?? "null"} afterDealId=${merged.bitrix_deal_id ?? "null"} dealUrl=${merged.deal_url ?? "null"} error=null source=${merged.deal_enrichment_source}`
      );
      return merged;
    }

    let activityFailReason: string | null = null;
    let activitySkipReason: string | null = null;

    if (isUsableCrmActivityId(ce.crm_activity_id)) {
      const resolution = await resolveDealByCrmActivityId(ce.crm_activity_id!.trim());
      if (resolution.deal) {
        const patch = {
          bitrix_deal_id: resolution.deal.id,
          deal_title: resolution.deal.title,
          deal_url: resolution.deal.url,
          deal_enriched_at: now,
          deal_enrichment_error: null as string | null,
          deal_enrichment_source: "crm_activity"
        };
        const { error } = await supabase.from("call_events").update(patch).eq("id", ce.id);
        if (error) console.log(`${LOG} persist_failed callEventId=${ce.id} err=${error.message}`);
        const merged = { ...ce, ...patch };
        console.log(
          `${LOG} pipeline callEventId=${ce.id} crmActivityId=${crmRaw} beforeDealId=${beforeDealId ?? "null"} afterDealId=${merged.bitrix_deal_id ?? "null"} dealUrl=${merged.deal_url ?? "null"} error=null source=crm_activity`
        );
        return merged;
      }
      activityFailReason = resolution.reason ?? "deal_not_found_for_activity";
    } else {
      activitySkipReason = !crmRaw ? "missing_crm_activity_id" : "crm_activity_id_is_zero";
    }

    const phone = ce.phone_normalized?.trim() ?? "";
    let phoneTried = false;
    if (phone) {
      phoneTried = true;
      const phoneDeal = await resolveDealByPhoneLookup(phone);
      if (phoneDeal) {
        const patch = {
          bitrix_deal_id: phoneDeal.id,
          deal_title: phoneDeal.title,
          deal_url: phoneDeal.url,
          deal_enriched_at: now,
          deal_enrichment_error: null as string | null,
          deal_enrichment_source: "phone_lookup"
        };
        const { error } = await supabase.from("call_events").update(patch).eq("id", ce.id);
        if (error) console.log(`${LOG} persist_failed callEventId=${ce.id} err=${error.message}`);
        const merged = { ...ce, ...patch };
        console.log(
          `${LOG} pipeline callEventId=${ce.id} crmActivityId=${crmRaw || "null"} beforeDealId=${beforeDealId ?? "null"} afterDealId=${merged.bitrix_deal_id ?? "null"} dealUrl=${merged.deal_url ?? "null"} error=null source=phone_lookup`
        );
        return merged;
      }
    }

    let finalErr: string;
    if (phoneTried) {
      finalErr = "deal_not_found_by_phone";
    } else if (activityFailReason) {
      finalErr = activityFailReason;
    } else if (activitySkipReason) {
      finalErr = activitySkipReason;
    } else {
      finalErr = "not_found";
    }

    const { error } = await persistSkipReason(supabase, ce, now, finalErr, "not_found");
    if (error) console.log(`${LOG} persist_failed callEventId=${ce.id} err=${error.message}`);
    const merged = {
      ...ce,
      deal_enriched_at: now,
      deal_enrichment_error: finalErr,
      deal_enrichment_source: "not_found"
    };
    console.log(
      `${LOG} pipeline callEventId=${ce.id} crmActivityId=${crmRaw || "null"} beforeDealId=${beforeDealId ?? "null"} afterDealId=null dealUrl=null error=${finalErr} source=not_found`
    );
    return merged;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const { error } = await supabase
      .from("call_events")
      .update({
        deal_enriched_at: now,
        deal_enrichment_error: `enrichment_exception:${msg}`,
        deal_enrichment_source: "not_found"
      })
      .eq("id", ce.id);
    if (error) console.log(`${LOG} persist_failed callEventId=${ce.id} err=${error.message}`);
    console.log(
      `${LOG} pipeline callEventId=${ce.id} crmActivityId=${crmRaw || "null"} beforeDealId=${beforeDealId ?? "null"} afterDealId=null dealUrl=null error=enrichment_exception:${msg} source=not_found`
    );
    return {
      ...ce,
      deal_enriched_at: now,
      deal_enrichment_error: `enrichment_exception:${msg}`,
      deal_enrichment_source: "not_found"
    };
  }
}

/** @deprecated Use {@link enrichCallEventDealPipeline}. */
export const enrichCallEventDealIfNeeded = enrichCallEventDealPipeline;
