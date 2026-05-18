import { createServiceRoleClient } from "@/lib/supabase/server";
import {
  findFirstSuccessfulContactAfterMissed,
  type SuccessfulContactCallRow
} from "@/src/lib/bitrixbot/find-successful-contact-after-missed";

type MissedCallCaseRow = {
  id: string;
  status: string;
  phone_normalized: string;
  manager_bitrix_user_id: string | null;
  last_missed_at: string;
};

export type FindCallbackResult =
  | {
      found: false;
      matchedBy: null;
      callbackCallEventId: null;
      callbackOccurredAt: null;
      matchedCall?: null;
      warning?: string;
    }
  | {
      found: true;
      matchedBy: "phone+manager" | "phone_only";
      callbackCallEventId: string;
      callbackOccurredAt: string;
      matchedCall: SuccessfulContactCallRow;
    };

/** Обнаружить успешный созвон с клиентом после `last_missed_at` (входящий или исходящий). */
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

  const match = await findFirstSuccessfulContactAfterMissed(supabase, {
    phone_normalized: c.phone_normalized,
    manager_bitrix_user_id: c.manager_bitrix_user_id,
    last_missed_at: c.last_missed_at
  });

  if (!match) {
    return { found: false, matchedBy: null, callbackCallEventId: null, callbackOccurredAt: null };
  }

  const row = match.row;
  return {
    found: true,
    matchedBy: match.matchedBy,
    callbackCallEventId: row.id,
    callbackOccurredAt: row.occurred_at,
    matchedCall: row
  };
}
