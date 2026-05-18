import type { SupabaseClient } from "@supabase/supabase-js";
import { withTimeout } from "@/src/lib/bitrixbot/async-timeout";
import { findFirstSuccessfulContactAfterMissed } from "@/src/lib/bitrixbot/find-successful-contact-after-missed";

const DB_MS = 2_500;

/**
 * Блокирует подготовку missed-call уведомлений, если после `last_missed_at` уже был
 * успешный созвон с клиентом по этому номеру (входящий или исходящий).
 */
export async function outboundActivityBlocksMissedPrepare(
  supabase: SupabaseClient,
  input: {
    phone_normalized: string;
    last_missed_at: string;
    manager_bitrix_user_id: string | null;
  }
): Promise<string | null> {
  const phone = input.phone_normalized?.trim();
  if (!phone) return null;

  const hit = await withTimeout(
    findFirstSuccessfulContactAfterMissed(supabase, {
      phone_normalized: phone,
      manager_bitrix_user_id: input.manager_bitrix_user_id,
      last_missed_at: input.last_missed_at
    }),
    DB_MS,
    "contact_restored_after_missed_lookup"
  );

  if (hit) return "contact_restored_after_missed";
  return null;
}
