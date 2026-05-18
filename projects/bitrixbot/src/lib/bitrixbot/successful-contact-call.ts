import { normalizeBitrixUserId } from "@/src/lib/bitrixbot/bitrix-user-id";
import {
  callEventIsStrictly304MissedPattern,
  type CallEventForInboundFilter
} from "@/src/lib/bitrixbot/missed-inbound-customer-call";

/**
 * Row shape sufficient to decide if a call event is a real successful conversation
 * with the client (inbound or outbound).
 */
export type SuccessfulContactCallLike = {
  id?: string;
  status?: string | null;
  phone_normalized?: string | null;
  manager_bitrix_user_id?: string | null;
  call_duration_seconds?: number | null;
  failed_code?: string | null;
  raw_payload?: unknown;
};

function asInboundFilter(row: SuccessfulContactCallLike): CallEventForInboundFilter {
  return {
    id: row.id ?? "unknown",
    raw_payload: row.raw_payload ?? {},
    phone_normalized: row.phone_normalized,
    manager_bitrix_user_id: row.manager_bitrix_user_id,
    failed_code: row.failed_code,
    status: row.status ?? undefined,
    call_duration_seconds: row.call_duration_seconds
  };
}

/**
 * Успешный созвон с клиентом для логики «контакт восстановлен».
 *
 * Требования: менеджер, номер, статус success в БД, не чистый 304-missed,
 * либо ненулевая длительность, либо статус уже success (явный успех по правилам ingest).
 */
export function isSuccessfulContactCall(callEvent: SuccessfulContactCallLike): boolean {
  if (!normalizeBitrixUserId(callEvent.manager_bitrix_user_id)) return false;
  const phone = callEvent.phone_normalized?.trim() ?? "";
  if (!phone) return false;

  const st = String(callEvent.status ?? "").trim().toLowerCase();
  if (st !== "success") return false;

  if (callEventIsStrictly304MissedPattern(asInboundFilter(callEvent))) return false;

  const dur = callEvent.call_duration_seconds ?? 0;
  if (dur > 0) return true;

  // Явный success без положительной длительности (классификация Voximplant по токенам).
  return true;
}
