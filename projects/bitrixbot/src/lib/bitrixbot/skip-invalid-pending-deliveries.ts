import type { SupabaseClient } from "@supabase/supabase-js";

export type SkipInvalidPendingDeliveriesSummary = {
  /** Rows matching skip criteria before applying batch limit */
  candidatesInBatch: number;
  /** Rows updated to skipped in this invocation */
  skipped: number;
  reasons: Record<string, number>;
};

type RpcSkipResult = {
  candidates_in_batch?: number;
  skipped?: number;
  reasons?: Record<string, number>;
};

/**
 * Marks pending deliveries as skipped (no deletes) via DB batch:
 * invalid/null/empty/'0' recipient, "Не назначен" placeholders in message_text,
 * or created_at older than stale window.
 */
export async function skipInvalidPendingDeliveries(
  supabase: SupabaseClient,
  limit = 5000,
  staleMinutes = 30
): Promise<SkipInvalidPendingDeliveriesSummary> {
  const capped = Math.max(1, Math.min(5000, Math.floor(limit)));
  const stale = staleMinutes <= 0 ? 30 : Math.floor(staleMinutes);

  const { data, error } = await supabase.rpc("skip_invalid_pending_notification_deliveries", {
    p_limit: capped,
    p_stale_minutes: stale
  });

  if (error) throw new Error(error.message);

  const row = data as RpcSkipResult | null;
  return {
    candidatesInBatch:
      typeof row?.candidates_in_batch === "number" ? row.candidates_in_batch : 0,
    skipped: typeof row?.skipped === "number" ? row.skipped : 0,
    reasons: row?.reasons && typeof row.reasons === "object" ? row.reasons : {}
  };
}
