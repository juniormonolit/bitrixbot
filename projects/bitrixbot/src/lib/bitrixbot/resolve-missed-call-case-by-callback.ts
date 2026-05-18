import { createServiceRoleClient } from "@/lib/supabase/server";
import { callEventHasOutboundSignals } from "@/src/lib/bitrixbot/call-event-outbound";
import { findCallbackForCase } from "@/src/lib/bitrixbot/find-callback-for-case";

type ResolveResultStatus = "resolved" | "skipped" | "noop";

export type ResolveCaseByCallbackResult = {
  caseId: string;
  status: ResolveResultStatus;
  matchedBy: string | null;
  callbackCallEventId: string | null;
  callbackOccurredAt: string | null;
  warnings: string[];
};

export async function resolveMissedCallCaseByCallback(
  caseId: string
): Promise<ResolveCaseByCallbackResult> {
  const supabase = createServiceRoleClient();
  const warnings: string[] = [];

  const { data: caseRow, error: caseErr } = await supabase
    .from("missed_call_cases")
    .select("id, status, phone_normalized")
    .eq("id", caseId)
    .maybeSingle();
  if (caseErr) throw new Error(caseErr.message);
  if (!caseRow) {
    return {
      caseId,
      status: "skipped",
      matchedBy: null,
      callbackCallEventId: null,
      callbackOccurredAt: null,
      warnings: ["case_not_found"]
    };
  }

  const status = (caseRow as { status: string }).status;
  if (status !== "open") {
    return {
      caseId,
      status: "skipped",
      matchedBy: null,
      callbackCallEventId: null,
      callbackOccurredAt: null,
      warnings
    };
  }

  const cb = await findCallbackForCase(caseId);
  if (!cb.found) {
    if (cb.warning) warnings.push(cb.warning);
    return {
      caseId,
      status: "noop",
      matchedBy: null,
      callbackCallEventId: null,
      callbackOccurredAt: null,
      warnings
    };
  }

  const now = new Date().toISOString();
  const patch: {
    last_successful_callback_at: string;
    status: "resolved_after_contact";
    last_outbound_at?: string;
  } = {
    last_successful_callback_at: cb.callbackOccurredAt,
    status: "resolved_after_contact"
  };
  if (callEventHasOutboundSignals(cb.matchedCall)) {
    patch.last_outbound_at = cb.callbackOccurredAt;
  }

  const { error: updErr } = await supabase.from("missed_call_cases").update(patch).eq("id", caseId);
  if (updErr) throw new Error(updErr.message);

  const phoneNorm = (caseRow as { phone_normalized?: string }).phone_normalized ?? "";
  const mc = cb.matchedCall;
  const matchedCallType =
    mc.call_direction?.trim() ||
    (mc.call_type_raw === "1" ? "outbound" : mc.call_type_raw === "2" ? "inbound" : null) ||
    mc.call_type_raw ||
    null;

  console.log("[missed_call_case_resolved_after_contact]", {
    case_id: caseId,
    phone_normalized: phoneNorm,
    matched_call_event_id: mc.id,
    matched_call_type: matchedCallType,
    matched_called_at: mc.occurred_at,
    matched_duration_seconds: mc.call_duration_seconds,
    manager_bitrix_user_id: mc.manager_bitrix_user_id
  });

  const { error: execErr } = await supabase
    .from("case_rule_executions")
    .update({
      execution_status: "obsolete",
      resolved_at: now,
      notes: "case resolved after successful contact"
    })
    .eq("case_id", caseId)
    .eq("execution_status", "pending");
  if (execErr) throw new Error(execErr.message);

  return {
    caseId,
    status: "resolved",
    matchedBy: cb.matchedBy,
    callbackCallEventId: cb.callbackCallEventId,
    callbackOccurredAt: cb.callbackOccurredAt,
    warnings
  };
}
