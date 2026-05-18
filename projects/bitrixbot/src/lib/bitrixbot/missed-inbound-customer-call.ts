import { normalizeBitrixUserId } from "@/src/lib/bitrixbot/bitrix-user-id";
import { resolveCallTypeDigits } from "@/src/lib/bitrixbot/call-event-outbound";
import { extractVoximplantDataPayload } from "@/src/lib/bitrixbot/voximplant-inbound-missed";

type JsonObject = Record<string, unknown>;

function getObj(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  return {};
}

function getString(value: unknown): string | null {
  if (typeof value === "string") {
    const v = value.trim();
    return v ? v : null;
  }
  if (typeof value === "number") return String(value);
  return null;
}

function webhookEventName(raw_payload: unknown): string | null {
  const root = getObj(raw_payload);
  return getString(root.event) ?? getString(root.EVENT);
}

/** Все ненулевые источники failed-кода должны быть ровно "304" (колонка и/или payload). */
function failedCodesAgreeStrictly304(callEvent: CallEventForInboundFilter): boolean {
  const col = callEvent.failed_code?.trim() ?? "";
  const data = extractVoximplantDataPayload(callEvent.raw_payload);
  const payload = getString(data.CALL_FAILED_CODE) ?? "";
  const parts = [col, payload].filter((x) => x !== "");
  if (parts.length === 0) return false;
  return parts.every((c) => c === "304");
}

/** Паттерн «пропуск по 304» — такие звонки не считаются успешным контактом. */
export function callEventIsStrictly304MissedPattern(callEvent: CallEventForInboundFilter): boolean {
  return failedCodesAgreeStrictly304(callEvent);
}

export type MissedInboundCustomerCallEval =
  | { ok: true }
  | {
      ok: false;
      reason:
        | "skip_not_call_end"
        | "skip_not_inbound_call_type"
        | "skip_not_missed_failed_code"
        | "skip_missing_manager"
        | "skip_missing_phone";
      callType?: string | null;
      event?: string | null;
    };

export type CallEventForInboundFilter = {
  id: string;
  raw_payload: unknown;
  phone_normalized?: string | null;
  manager_bitrix_user_id?: string | null;
  call_type_raw?: string | null;
  failed_code?: string | null;
  /** Не участвует в решении о missed кейсе — остаётся в типе для совместимости загрузки строк. */
  status?: string;
  call_direction?: string | null;
  call_duration_seconds?: number | null;
};

/** Для логов (убираем префикс skip_). */
export function filterSkipReasonLabel(reason: string): string {
  return reason.replace(/^skip_/, "");
}

/**
 * Строго по данным Bitrix/Voximplant: только ONVOXIMPLANTCALLEND + входящий (2) + 304 + менеджер + номер в БД.
 */
export function evaluateMissedInboundCustomerCall(
  callEvent: CallEventForInboundFilter
): MissedInboundCustomerCallEval {
  const eventName = webhookEventName(callEvent.raw_payload);
  const callType = resolveCallTypeDigits(callEvent).trim();

  if (eventName !== "ONVOXIMPLANTCALLEND") {
    return {
      ok: false,
      reason: "skip_not_call_end",
      event: eventName,
      callType: callType || null
    };
  }

  if (callType !== "2") {
    return {
      ok: false,
      reason: "skip_not_inbound_call_type",
      event: eventName,
      callType: callType || null
    };
  }

  if (!failedCodesAgreeStrictly304(callEvent)) {
    return {
      ok: false,
      reason: "skip_not_missed_failed_code",
      event: eventName,
      callType
    };
  }

  if (!normalizeBitrixUserId(callEvent.manager_bitrix_user_id)) {
    console.log("[alerting:missed-calls] Skipping call without manager_id", {
      call_event_id: callEvent.id,
      event: eventName,
      call_type: callType
    });
    return {
      ok: false,
      reason: "skip_missing_manager",
      event: eventName,
      callType
    };
  }

  const phoneNorm = callEvent.phone_normalized?.trim() ?? "";
  if (!phoneNorm) {
    return {
      ok: false,
      reason: "skip_missing_phone",
      event: eventName,
      callType
    };
  }

  return { ok: true };
}

export function isMissedInboundCustomerCall(callEvent: CallEventForInboundFilter): boolean {
  return evaluateMissedInboundCustomerCall(callEvent).ok;
}

export function isActuallyMissedInboundCallEvent(callEvent: CallEventForInboundFilter): boolean {
  return isMissedInboundCustomerCall(callEvent);
}
