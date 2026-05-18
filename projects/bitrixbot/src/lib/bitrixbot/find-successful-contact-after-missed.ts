import type { SupabaseClient } from "@supabase/supabase-js";
import { normalizeBitrixUserId } from "@/src/lib/bitrixbot/bitrix-user-id";
import { isSuccessfulContactCall } from "@/src/lib/bitrixbot/successful-contact-call";

export type SuccessfulContactCallRow = {
  id: string;
  occurred_at: string;
  manager_bitrix_user_id: string | null;
  phone_normalized: string | null;
  call_direction: string | null;
  call_type_raw: string | null;
  call_duration_seconds: number | null;
  status: string;
  failed_code: string | null;
  raw_payload: unknown;
};

const CANDIDATE_LIMIT = 40;

const SELECT_FIELDS =
  "id, occurred_at, manager_bitrix_user_id, phone_normalized, call_direction, call_type_raw, call_duration_seconds, status, failed_code, raw_payload";

async function firstSuccessfulFromRows(rows: unknown[] | null): Promise<SuccessfulContactCallRow | null> {
  for (const r of rows ?? []) {
    const row = r as SuccessfulContactCallRow;
    if (isSuccessfulContactCall(row)) return row;
  }
  return null;
}

export type SuccessfulContactMatch = {
  row: SuccessfulContactCallRow;
  matchedBy: "phone+manager" | "phone_only";
};

/**
 * Первый хронологически успешный контакт после `last_missed_at` (строго позже timestamp),
 * с тем же нормализованным номером. Сначала успех по связке phone+manager кейса, иначе любой менеджер.
 */
export async function findFirstSuccessfulContactAfterMissed(
  supabase: SupabaseClient,
  input: {
    phone_normalized: string;
    manager_bitrix_user_id: string | null;
    last_missed_at: string;
  }
): Promise<SuccessfulContactMatch | null> {
  const phone = input.phone_normalized.trim();
  if (!phone) return null;

  const afterIso = input.last_missed_at;
  const mgr = normalizeBitrixUserId(input.manager_bitrix_user_id);

  const base = () =>
    supabase
      .from("call_events")
      .select(SELECT_FIELDS)
      .eq("status", "success")
      .eq("phone_normalized", phone)
      .gt("occurred_at", afterIso)
      .order("occurred_at", { ascending: true })
      .limit(CANDIDATE_LIMIT);

  if (mgr) {
    const { data: strict, error: sErr } = await base().eq("manager_bitrix_user_id", mgr);
    if (sErr) throw new Error(sErr.message);
    const hit = await firstSuccessfulFromRows(strict);
    if (hit) return { row: hit, matchedBy: "phone+manager" };
  }

  const { data: loose, error: lErr } = await base();
  if (lErr) throw new Error(lErr.message);
  const hit2 = await firstSuccessfulFromRows(loose);
  if (hit2) return { row: hit2, matchedBy: "phone_only" };
  return null;
}
