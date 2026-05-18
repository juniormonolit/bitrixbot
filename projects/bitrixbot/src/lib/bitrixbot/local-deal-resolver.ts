import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizePhoneForAnalytics } from "@/lib/bitrix/phone-normalize";
import { env } from "@/lib/env";

const LOG = "[LOCAL DEAL RESOLVER]";

export type ResolvedDealFromLocalDb = {
  id: string;
  title: string;
  url: string;
};

function isClosedSemantic(sem: string | null | undefined): boolean {
  if (!sem) return false;
  const u = sem.toUpperCase();
  return u === "S" || u === "F" || u === "W" || u === "L";
}

/**
 * Pick best active (non-archived, non-terminal semantic) deal for a canonical phone key.
 */
export async function resolveActiveDealForPhone(
  supabase: SupabaseClient,
  phoneRaw: string | null | undefined
): Promise<ResolvedDealFromLocalDb | null> {
  const phone_normalized = normalizePhoneForAnalytics(phoneRaw ?? "") ?? "";
  if (!phone_normalized) {
    console.log(`${LOG}`, {
      phone_normalized: null,
      match: "not_found",
      selected_deal_id: null,
      reason: "empty_phone"
    });
    return null;
  }

  const { data: links, error: linkErr } = await supabase
    .from("deal_phone_index")
    .select("bitrix_deal_id")
    .eq("phone_normalized", phone_normalized);

  if (linkErr) {
    console.log(`${LOG}`, {
      phone_normalized,
      match: "error",
      selected_deal_id: null,
      reason: `deal_phone_index_query:${linkErr.message}`
    });
    return null;
  }

  const ids = [
    ...new Set(
      (links ?? [])
        .map((r) => String((r as { bitrix_deal_id?: string }).bitrix_deal_id ?? "").trim())
        .filter(Boolean)
    )
  ];

  if (ids.length === 0) {
    console.log(`${LOG}`, {
      phone_normalized,
      match: "not_found",
      selected_deal_id: null,
      reason: "no_deal_phone_index_rows"
    });
    return null;
  }

  const { data: dealRows, error: dealErr } = await supabase
    .from("deals")
    .select("bitrix_deal_id, title, is_archived, stage_semantic_id, updated_at_source")
    .in("bitrix_deal_id", ids);

  if (dealErr) {
    console.log(`${LOG}`, {
      phone_normalized,
      match: "error",
      selected_deal_id: null,
      reason: `deals_query:${dealErr.message}`
    });
    return null;
  }

  type DealRow = {
    bitrix_deal_id: string;
    title: string | null;
    is_archived: boolean | null;
    stage_semantic_id: string | null;
    updated_at_source: string | null;
  };

  const rows = (dealRows ?? []) as DealRow[];
  const active = rows.filter((r) => !r.is_archived && !isClosedSemantic(r.stage_semantic_id));

  const pool = active.length > 0 ? active : [];
  if (pool.length === 0) {
    console.log(`${LOG}`, {
      phone_normalized,
      match: "not_found",
      selected_deal_id: null,
      reason: "only_archived_or_closed_deals"
    });
    return null;
  }

  pool.sort((a, b) => {
    const ta = a.updated_at_source ? new Date(a.updated_at_source).getTime() : 0;
    const tb = b.updated_at_source ? new Date(b.updated_at_source).getTime() : 0;
    return tb - ta;
  });

  const best = pool[0]!;
  const id = String(best.bitrix_deal_id).trim();
  const title = (best.title?.trim() || `Сделка #${id}`).slice(0, 500);
  const base = env.BITRIX_PORTAL_URL.replace(/\/$/, "");
  const url = `${base}/crm/deal/details/${encodeURIComponent(id)}/`;

  console.log(`${LOG}`, {
    phone_normalized,
    match: "found",
    selected_deal_id: id,
    reason: "best_active_by_updated_at_source"
  });

  return { id, title, url };
}
