import type { SupabaseClient } from "@supabase/supabase-js";
import { formatPhoneForDisplay } from "@/lib/bitrix/phone-normalize";

/**
 * Deal ↔ call linkage disabled. Stubs keep debug/admin routes importable without touching deals tables.
 */

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

export async function reEnrichMissedCallCaseDeal(
  _supabase: SupabaseClient,
  caseId: string,
  _opts?: { phoneEventLimit?: number }
): Promise<ReEnrichCaseDealResult> {
  return {
    ok: true,
    caseId,
    beforeCase: null,
    afterCase: null,
    enrichedCallEvents: [],
    chosenDeal: null,
    errors: ["deal_enrichment_disabled"]
  };
}

export function openCaseNeedsDealBackfill(_c: {
  deal_id: number | null;
  deal_url: string | null;
  deal_enriched_at: string | null;
}): boolean {
  return false;
}

export async function maybeReenrichCaseBeforeSend(
  _supabase: SupabaseClient,
  _caseId: string
): Promise<{ attempted: boolean; chosen: boolean }> {
  return { attempted: false, chosen: false };
}

export async function refreshPendingDeliveryMessageDealLine(
  _supabase: SupabaseClient,
  _deliveryId: string,
  _caseId: string
): Promise<{ updated: boolean }> {
  return { updated: false };
}

export async function refreshPendingDeliveryMessagePhoneLine(
  supabase: SupabaseClient,
  deliveryId: string,
  caseId: string
): Promise<{ updated: boolean }> {
  const { data: c } = await supabase
    .from("missed_call_cases")
    .select("phone_normalized")
    .eq("id", caseId)
    .maybeSingle();
  const raw = (c as { phone_normalized?: string } | null)?.phone_normalized?.trim() ?? "";
  if (!raw) return { updated: false };
  const formatted = formatPhoneForDisplay(raw);
  if (!formatted) return { updated: false };

  const { data: d } = await supabase
    .from("notification_deliveries")
    .select("message_text")
    .eq("id", deliveryId)
    .maybeSingle();
  const msg = d?.message_text ?? "";
  const next = msg.replace(/^(\s*Телефон:\s*)(.+)$/m, (_match: string, p1: string) => `${p1}${formatted}`);
  if (next === msg) return { updated: false };

  const { error } = await supabase.from("notification_deliveries").update({ message_text: next }).eq("id", deliveryId);
  if (error) return { updated: false };
  return { updated: true };
}
