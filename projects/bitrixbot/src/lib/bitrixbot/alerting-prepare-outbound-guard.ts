import type { SupabaseClient } from "@supabase/supabase-js";
import { withTimeout } from "@/lib/bitrixbot/async-timeout";
import { callEventHasOutboundSignals } from "@/lib/bitrixbot/call-event-outbound";
import { collectCallEventIdsFromCaseContext } from "@/lib/bitrixbot/case-call-events";

const DB_MS = 2_500;

/**
 * Blocks preparing missed-call notifications when CRM traffic clearly shows outbound:
 * - newest call_events row for this phone is outbound, or
 * - case.context last trigger call_event id points at outbound ingest.
 *
 * Covers SLA / escalation paths that do not attach a fresh inbound missed event.
 */
export async function outboundActivityBlocksMissedPrepare(
  supabase: SupabaseClient,
  input: { phone_normalized: string; context: unknown }
): Promise<string | null> {
  const phone = input.phone_normalized?.trim();
  if (!phone) return null;

  const { data: latest, error: latestErr } = await withTimeout(
    supabase
      .from("call_events")
      .select("call_direction, call_type_raw, raw_payload")
      .eq("phone_normalized", phone)
      .order("occurred_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    DB_MS,
    "outbound_guard_latest_phone_call"
  );
  if (latestErr) throw new Error(latestErr.message);
  if (latest && callEventHasOutboundSignals(latest)) {
    return "latest_call_on_phone_is_outbound";
  }
  if (latest) {
    return null;
  }

  const ids = collectCallEventIdsFromCaseContext(input.context);
  const triggerId = ids[0];
  if (triggerId) {
    const { data: trig, error: trigErr } = await withTimeout(
      supabase
        .from("call_events")
        .select("call_direction, call_type_raw, raw_payload")
        .eq("id", triggerId)
        .maybeSingle(),
      DB_MS,
      "outbound_guard_context_trigger_call"
    );
    if (trigErr) throw new Error(trigErr.message);
    if (trig && callEventHasOutboundSignals(trig)) {
      return "case_context_trigger_call_event_outbound";
    }
  }

  return null;
}
