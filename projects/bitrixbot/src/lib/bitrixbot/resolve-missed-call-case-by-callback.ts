import { createServiceRoleClient } from "@/lib/supabase/server";
import { findCallbackForCase } from "@/lib/bitrixbot/find-callback-for-case";

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
    .select("id, status, last_missed_at")
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
  const { error: updErr } = await supabase
    .from("missed_call_cases")
    .update({
      last_outbound_at: cb.callbackOccurredAt,
      last_successful_callback_at: cb.callbackOccurredAt,
      status: "resolved"
    })
    .eq("id", caseId);
  if (updErr) throw new Error(updErr.message);

  // Cancel any pending SLA executions for this case
  const { error: execErr } = await supabase
    .from("case_rule_executions")
    .update({ execution_status: "obsolete", resolved_at: now, notes: "case resolved by callback" })
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

