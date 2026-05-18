import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

export type CallEventDealEnrichmentRow = {
  id: string;
  bitrix_deal_id: string | null;
  crm_activity_id: string | null;
  phone_normalized?: string | null;
  deal_title: string | null;
  deal_url: string | null;
  deal_enriched_at: string | null;
  deal_enrichment_error: string | null;
  deal_enrichment_source: string | null;
};

export function normalizeStoredDealUrl(value: string | null | undefined): string | null {
  if (value == null) return null;
  const v = String(value).trim();
  if (!v) return null;
  if (v === "Сделка: не определена") return null;
  if (v === "не определена") return null;
  if (v.includes("не определена")) return null;
  if (v === "не найдена") return null;
  if (v.includes("не найдена")) return null;
  return v;
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
  const normalizedStored = normalizeStoredDealUrl(storedUrl);
  if (normalizedStored) {
    const stripped = stripLegacyDealLabelPrefix(normalizedStored);
    return stripped || "не найдена";
  }
  const built = buildDealDetailsUrl(dealId);
  return built || "не найдена";
}

/**
 * Disabled: call → deal enrichment removed from product. No-op (no DB writes, no index lookups).
 */
export async function enrichCallEventDealPipeline(
  _supabase: SupabaseClient,
  ce: CallEventDealEnrichmentRow,
  _options?: { force?: boolean }
): Promise<CallEventDealEnrichmentRow> {
  return ce;
}

/** @deprecated Use {@link enrichCallEventDealPipeline}. */
export const enrichCallEventDealIfNeeded = enrichCallEventDealPipeline;
