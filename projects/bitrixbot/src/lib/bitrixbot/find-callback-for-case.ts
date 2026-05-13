import { createServiceRoleClient } from "@/lib/supabase/server";

type MissedCallCaseRow = {
  id: string;
  status: string;
  phone_normalized: string;
  manager_bitrix_user_id: string | null;
  last_missed_at: string;
};

type CallEventRow = {
  id: string;
  occurred_at: string;
  manager_bitrix_user_id: string | null;
};

export type FindCallbackResult =
  | { found: false; matchedBy: null; callbackCallEventId: null; callbackOccurredAt: null; warning?: string }
  | { found: true; matchedBy: "phone+manager" | "phone_only"; callbackCallEventId: string; callbackOccurredAt: string };

export async function findCallbackForCase(caseId: string): Promise<FindCallbackResult> {
  const supabase = createServiceRoleClient();

  const { data: caseRow, error: caseErr } = await supabase
    .from("missed_call_cases")
    .select("id, status, phone_normalized, manager_bitrix_user_id, last_missed_at")
    .eq("id", caseId)
    .maybeSingle();
  if (caseErr) throw new Error(caseErr.message);
  if (!caseRow) {
    return {
      found: false,
      matchedBy: null,
      callbackCallEventId: null,
      callbackOccurredAt: null,
      warning: "case_not_found"
    };
  }

  const c = caseRow as MissedCallCaseRow;
  if (!c.phone_normalized) {
    return { found: false, matchedBy: null, callbackCallEventId: null, callbackOccurredAt: null };
  }

  const baseQuery = supabase
    .from("call_events")
    .select("id, occurred_at, manager_bitrix_user_id")
    .eq("status", "success")
    .eq("phone_normalized", c.phone_normalized)
    .gte("occurred_at", c.last_missed_at)
    .order("occurred_at", { ascending: true })
    .limit(1);

  if (c.manager_bitrix_user_id) {
    const { data: strict, error: strictErr } = await baseQuery
      .eq("manager_bitrix_user_id", c.manager_bitrix_user_id)
      .maybeSingle();
    if (strictErr) throw new Error(strictErr.message);
    if (strict) {
      const ev = strict as CallEventRow;
      return {
        found: true,
        matchedBy: "phone+manager",
        callbackCallEventId: ev.id,
        callbackOccurredAt: ev.occurred_at
      };
    }
  }

  const { data: fallback, error: fbErr } = await baseQuery.maybeSingle();
  if (fbErr) throw new Error(fbErr.message);
  if (!fallback) {
    return { found: false, matchedBy: null, callbackCallEventId: null, callbackOccurredAt: null };
  }

  const ev = fallback as CallEventRow;
  return {
    found: true,
    matchedBy: "phone_only",
    callbackCallEventId: ev.id,
    callbackOccurredAt: ev.occurred_at
  };
}

