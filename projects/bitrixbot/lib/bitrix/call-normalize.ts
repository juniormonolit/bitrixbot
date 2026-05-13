import { normalizePhoneForAnalytics } from "@/lib/bitrix/phone-normalize";

type JsonObject = Record<string, unknown>;

export type NormalizedCallEvent = {
  manager_bitrix_user_id: string | null;
  bitrix_deal_id: string | null;
  phone: string | null;
  phone_normalized: string | null;
  status: "missed" | "success" | "other";
  crm_activity_id: string | null;
  bitrix_call_id: string | null;
  occurred_at: string;
  call_type_raw: string | null;
  call_direction: "inbound" | "outbound" | "unknown";
  call_duration_seconds: number | null;
  failed_code: string | null;
  failed_reason: string | null;
  call_started_at: string | null;
  raw_payload: unknown;
};

function getObj(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as JsonObject;
  }
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

function computeStatus(data: JsonObject): "missed" | "success" | "other" {
  const duration = getNumber(data.CALL_DURATION);
  if (duration !== null && duration > 0) return "success";

  const failedCodeStr = getString(data.CALL_FAILED_CODE);
  if (failedCodeStr && failedCodeStr !== "0") return "missed";

  return "other";
}

export function normalizeBitrixCallEvent(
  eventName: string,
  payload: unknown
): NormalizedCallEvent | null {
  if (eventName !== "ONVOXIMPLANTCALLEND") {
    return null;
  }

  const root = getObj(payload);
  const data = getObj(root.data ?? root.DATA);
  const auth = getObj(root.auth ?? root.AUTH);

  const bitrixCallId = getString(data.CALL_ID) ?? getString(data.call_id);
  const phone = getString(data.PHONE_NUMBER) ?? getString(data.phone);
  const crmActivityId =
    getString(data.CRM_ACTIVITY_ID) ?? getString(data.crm_activity_id);

  const managerUserId =
    getString(data.PORTAL_USER_ID) ??
    getString(data.USER_ID) ??
    getString(data.user_id) ??
    getString(auth.user_id) ??
    getString(auth.USER_ID);

  const crmEntityTypeStr =
    (getString(data.CRM_ENTITY_TYPE) ?? getString(data.crm_entity_type))?.toUpperCase() ?? null;
  const crmEntityTypeNum = getNumber(data.CRM_ENTITY_TYPE) ?? getNumber(data.crm_entity_type);
  const isDealEntity = crmEntityTypeStr === "DEAL" || crmEntityTypeNum === 2;
  const crmEntityId = getString(data.CRM_ENTITY_ID) ?? getString(data.crm_entity_id);
  const dealId = isDealEntity ? crmEntityId : null;

  const status = computeStatus(data);
  const durationSeconds = getNumber(data.CALL_DURATION);
  // Bitrix Voximplant CALL_TYPE: "1" = исходящий (outbound), "2" = входящий (inbound).
  const callTypeRaw = getString(data.CALL_TYPE);
  const failedCode = getString(data.CALL_FAILED_CODE);
  const failedReason = getString(data.CALL_FAILED_REASON);
  const callStartDateRaw = getString(data.CALL_START_DATE);
  /** Bitrix Voximplant: 1 = outbound, 2 = inbound. */
  const callDirection =
    callTypeRaw === "1" ? "outbound" : callTypeRaw === "2" ? "inbound" : "unknown";

  return {
    manager_bitrix_user_id: managerUserId,
    bitrix_deal_id: dealId,
    phone,
    phone_normalized: normalizePhoneForAnalytics(phone),
    status,
    crm_activity_id: crmActivityId,
    bitrix_call_id: bitrixCallId,
    occurred_at: new Date().toISOString(),
    call_type_raw: callTypeRaw,
    call_direction: callDirection,
    call_duration_seconds: durationSeconds !== null ? Math.trunc(durationSeconds) : null,
    failed_code: failedCode,
    failed_reason: failedReason,
    call_started_at: callStartDateRaw,
    raw_payload: payload
  };
}

