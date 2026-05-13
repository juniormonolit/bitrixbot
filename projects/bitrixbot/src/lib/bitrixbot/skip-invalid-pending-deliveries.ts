import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeBitrixUserId } from "@/src/lib/bitrixbot/bitrix-user-id";
import { callEventHasOutboundSignals } from "@/src/lib/bitrixbot/call-event-outbound";
import { isActuallyMissedInboundCallEvent } from "@/src/lib/bitrixbot/missed-inbound-customer-call";
import {
  extractVoximplantDataPayload,
  payloadIndicatesInboundCallWasAnsweredOrCompleted
} from "@/src/lib/bitrixbot/voximplant-inbound-missed";

type MinimalCase = {
  id: string;
  manager_bitrix_user_id: string | null;
  phone_normalized: string | null;
  context: unknown;
};

type MinimalDelivery = {
  id: string;
  case_id: string;
  recipient_bitrix_user_id: string | null;
  message_text: string | null;
};

type CallEv = {
  id: string;
  occurred_at: string;
  status: string | null;
  raw_payload: unknown;
  phone_normalized: string | null;
  manager_bitrix_user_id: string | null;
  call_type_raw: string | null;
  call_direction: string | null;
  call_duration_seconds: number | null;
  failed_code: string | null;
};

const BAD_MESSAGE_FRAGMENTS = ["Менеджер: Не назначен", "Основной получатель: Не назначен"];

function pickSourceCallEventId(context: unknown): string | null {
  const o = context && typeof context === "object" ? (context as Record<string, unknown>) : {};
  const last = typeof o.last_call_event_id === "string" ? o.last_call_event_id.trim() : "";
  if (last) return last;
  const created =
    typeof o.created_from_call_event_id === "string" ? o.created_from_call_event_id.trim() : "";
  return created || null;
}

function eventIndicatesOutboundSuccessOrAnswered(ev: CallEv): boolean {
  if (callEventHasOutboundSignals(ev)) return true;
  if (ev.status?.trim() === "success") return true;
  const d = ev.call_duration_seconds;
  if (typeof d === "number" && Number.isFinite(d) && d > 0) return true;
  const data = extractVoximplantDataPayload(ev.raw_payload);
  if (payloadIndicatesInboundCallWasAnsweredOrCompleted(data)) return true;
  return false;
}

async function loadCallEventById(supabase: SupabaseClient, id: string): Promise<CallEv | null> {
  const { data, error } = await supabase
    .from("call_events")
    .select(
      "id, occurred_at, status, raw_payload, phone_normalized, manager_bitrix_user_id, call_type_raw, call_direction, call_duration_seconds, failed_code"
    )
    .eq("id", id)
    .maybeSingle();
  if (error || !data) return null;
  return data as CallEv;
}

async function loadLatestCallForPhone(supabase: SupabaseClient, phone: string): Promise<CallEv | null> {
  const { data, error } = await supabase
    .from("call_events")
    .select(
      "id, occurred_at, status, raw_payload, phone_normalized, manager_bitrix_user_id, call_type_raw, call_direction, call_duration_seconds, failed_code"
    )
    .eq("phone_normalized", phone)
    .order("occurred_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as CallEv;
}

function latestSupersedesSourceMissed(source: CallEv, latest: CallEv | null): boolean {
  if (!latest || latest.id === source.id) return false;
  const srcT = new Date(source.occurred_at).getTime();
  const latT = new Date(latest.occurred_at).getTime();
  if (!Number.isFinite(srcT) || !Number.isFinite(latT) || latT < srcT) return false;
  return eventIndicatesOutboundSuccessOrAnswered(latest);
}

export type SkipInvalidPendingDeliveriesSummary = {
  scanned: number;
  skipped: number;
  reasons: Record<string, number>;
};

/** Marks pending deliveries as skipped when case/recipient/source event / phone timeline invalidate them (no deletes). */
export async function skipInvalidPendingDeliveries(
  supabase: SupabaseClient,
  limit = 500
): Promise<SkipInvalidPendingDeliveriesSummary> {
  const { data: pending, error } = await supabase
    .from("notification_deliveries")
    .select("id, case_id, recipient_bitrix_user_id, message_text")
    .eq("delivery_status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw new Error(error.message);

  const rows = (pending ?? []) as MinimalDelivery[];
  const reasons: Record<string, number> = {};
  let skipped = 0;

  const bump = (code: string) => {
    reasons[code] = (reasons[code] ?? 0) + 1;
  };

  for (const d of rows) {
    let skipCode: string | null = null;
    const setSkip = (code: string) => {
      if (!skipCode) skipCode = code;
    };

    const msg = d.message_text ?? "";
    if (BAD_MESSAGE_FRAGMENTS.some((frag) => msg.includes(frag))) {
      setSkip("skip_bad_manager_placeholder_message");
    }
    if (!normalizeBitrixUserId(d.recipient_bitrix_user_id)) {
      setSkip("skip_missing_recipient");
    }

    const { data: caseRow, error: caseErr } = await supabase
      .from("missed_call_cases")
      .select("id, manager_bitrix_user_id, phone_normalized, context")
      .eq("id", d.case_id)
      .maybeSingle();

    if (caseErr || !caseRow) {
      setSkip("skip_case_not_found");
    } else {
      const c = caseRow as MinimalCase;
      if (!normalizeBitrixUserId(c.manager_bitrix_user_id)) {
        setSkip("skip_missing_case_manager");
      } else {
        const sourceId = pickSourceCallEventId(c.context);
        if (!sourceId) {
          setSkip("skip_no_source_call_event_in_context");
        } else {
          const sourceEv = await loadCallEventById(supabase, sourceId);
          if (!sourceEv) {
            setSkip("skip_source_call_event_not_found");
          } else if (
            !isActuallyMissedInboundCallEvent({
              ...sourceEv,
              status: sourceEv.status ?? ""
            })
          ) {
            setSkip("skip_source_not_strict_missed_inbound");
          } else {
            const phone = c.phone_normalized?.trim();
            if (phone) {
              const latest = await loadLatestCallForPhone(supabase, phone);
              if (latestSupersedesSourceMissed(sourceEv, latest)) {
                setSkip("skip_phone_superseded_by_success_or_outbound");
              }
            }
          }
        }
      }
    }

    if (!skipCode) continue;

    const { error: updErr } = await supabase
      .from("notification_deliveries")
      .update({
        delivery_status: "skipped",
        error_message: `manual_skip_invalid:${skipCode}`
      })
      .eq("id", d.id);

    if (updErr) throw new Error(updErr.message);
    skipped++;
    bump(skipCode);
  }

  return { scanned: rows.length, skipped, reasons };
}
