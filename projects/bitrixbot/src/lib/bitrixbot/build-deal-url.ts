import { dealUrlForMessageTemplate } from "@/src/lib/bitrixbot/deal-enrichment-from-activity";

function parseDealIdForTemplate(dealId: string | number | null | undefined): number | null {
  if (dealId === null || dealId === undefined) return null;
  const v = String(dealId).trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

/**
 * Back-compat: same as {@link dealUrlForMessageTemplate} with no stored URL.
 * @deprecated Prefer {@link dealUrlForMessageTemplate} or {@link buildDealDetailsUrl} from deal-enrichment-from-activity.
 */
export function buildDealUrl(dealId: string | number | null | undefined): string {
  return dealUrlForMessageTemplate(null, parseDealIdForTemplate(dealId));
}

export { buildDealDetailsUrl, dealUrlForMessageTemplate, normalizeStoredDealUrl } from "@/src/lib/bitrixbot/deal-enrichment-from-activity";
