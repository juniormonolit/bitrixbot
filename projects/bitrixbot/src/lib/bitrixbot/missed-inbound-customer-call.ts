import { callEventHasOutboundSignals, resolveCallTypeDigits } from "@/src/lib/bitrixbot/call-event-outbound";

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

function getNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const v = value.trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

/** Same missed heuristic as `computeStatus` in call-normalize (no answer / failed before connect). */
function isMissedCallPayload(data: JsonObject): boolean {
  const duration = getNumber(data.CALL_DURATION);
  if (duration !== null && duration > 0) return false;
  const failed = getString(data.CALL_FAILED_CODE);
  if (failed && failed !== "0") return true;
  return false;
}

function isLikelyInternalOrAppPhone(phone: string): boolean {
  const raw = phone.trim();
  if (!raw) return true;
  const lower = raw.toLowerCase();
  if (lower.includes("rest_app") || lower.includes("restapp") || lower.includes("sip:")) return true;
  const d = digitsOnly(raw);
  if (d.length > 0 && d.length <= 4) return true;
  return false;
}

export type MissedInboundCustomerCallEval =
  | { ok: true }
  | {
      ok: false;
      reason: string;
      callType?: string | null;
      event?: string | null;
    };

export type CallEventForInboundFilter = {
  id: string;
  status: string;
  raw_payload: unknown;
  phone_normalized?: string | null;
  manager_bitrix_user_id?: string | null;
  /** From call_events.call_type_raw — fallback if payload omits CALL_TYPE. */
  call_type_raw?: string | null;
  /** From call_events.call_direction — secondary guard for outbound (same ingest as CALL_TYPE). */
  call_direction?: string | null;
};

/**
 * Человекочитаемая причина для логов (без префикса skip_).
 */
export function filterSkipReasonLabel(reason: string): string {
  return reason.replace(/^skip_/, "");
}

/**
 * Bitrix Voximplant telephony (typical mapping):
 * - CALL_TYPE 1 = outbound, 2 = inbound. Type 3 is not treated as customer inbound here.
 */
export function evaluateMissedInboundCustomerCall(callEvent: CallEventForInboundFilter): MissedInboundCustomerCallEval {
  const root = getObj(callEvent.raw_payload);
  const eventName = getString(root.event) ?? getString(root.EVENT);
  if (eventName && eventName !== "ONVOXIMPLANTCALLEND") {
    return { ok: false, reason: "skip_call_event_not_final", event: eventName };
  }

  const data = getObj(root.data ?? root.DATA);

  if (callEventHasOutboundSignals(callEvent)) {
    const ct = resolveCallTypeDigits(callEvent).trim();
    return {
      ok: false,
      reason: "skip_outgoing_call",
      callType: ct || callEvent.call_type_raw?.trim() || null,
      event: eventName
    };
  }

  const callType = resolveCallTypeDigits(callEvent).trim();

  if (callType === "3") {
    return { ok: false, reason: "skip_call_type_3", callType, event: eventName };
  }
  if (callType !== "2") {
    return { ok: false, reason: "skip_unknown_call_type", callType: callType || null, event: eventName };
  }

  if (callEvent.status !== "missed") {
    return { ok: false, reason: "skip_not_missed_status", callType, event: eventName };
  }

  if (!isMissedCallPayload(data)) {
    return { ok: false, reason: "skip_not_missed", callType, event: eventName };
  }

  const phone =
    getString(data.PHONE_NUMBER) ??
    getString(data.phone) ??
    (callEvent.phone_normalized?.trim() ? callEvent.phone_normalized.trim() : null);
  if (!phone) {
    return { ok: false, reason: "skip_missing_phone", callType, event: eventName };
  }

  if (isLikelyInternalOrAppPhone(phone)) {
    return { ok: false, reason: "skip_phone_internal_like", callType, event: eventName };
  }

  const portalNum = getString(data.PORTAL_NUMBER) ?? getString(data.portal_number);
  if (portalNum) {
    const a = digitsOnly(phone);
    const b = digitsOnly(portalNum);
    if (a.length > 0 && b.length > 0 && a === b) {
      return { ok: false, reason: "skip_phone_same_as_portal", callType, event: eventName };
    }
  }

  const manager =
    getString(data.PORTAL_USER_ID) ??
    getString(data.USER_ID) ??
    getString(data.user_id) ??
    (callEvent.manager_bitrix_user_id?.trim() ? callEvent.manager_bitrix_user_id.trim() : null);
  if (!manager) {
    return { ok: false, reason: "skip_missing_manager_portal_user", callType, event: eventName };
  }

  return { ok: true };
}

export function isMissedInboundCustomerCall(callEvent: CallEventForInboundFilter): boolean {
  return evaluateMissedInboundCustomerCall(callEvent).ok;
}
