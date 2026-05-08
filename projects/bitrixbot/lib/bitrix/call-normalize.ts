type JsonObject = Record<string, unknown>;

export type NormalizedCallEvent = {
  manager_bitrix_user_id: string | null;
  bitrix_deal_id: string | null;
  phone: string | null;
  status: "missed" | "success" | "other";
  crm_activity_id: string | null;
  bitrix_call_id: string | null;
  occurred_at: string;
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
  const failedCode = getNumber(data.CALL_FAILED_CODE);
  if (failedCode !== null && failedCode !== 0) return "missed";

  const duration = getNumber(data.CALL_DURATION);
  if (duration !== null && duration > 0) return "success";

  return "other";
}

export function normalizeBitrixCallEvent(
  eventName: string,
  payload: unknown
): NormalizedCallEvent | null {
  if (
    eventName !== "ONVOXIMPLANTCALLINIT" &&
    eventName !== "ONVOXIMPLANTCALLSTART" &&
    eventName !== "ONVOXIMPLANTCALLEND"
  ) {
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
    getString(data.USER_ID) ??
    getString(data.user_id) ??
    getString(auth.user_id) ??
    getString(auth.USER_ID);

  const crmEntityType =
    (getString(data.CRM_ENTITY_TYPE) ?? getString(data.crm_entity_type))?.toUpperCase() ??
    null;
  const crmEntityId = getString(data.CRM_ENTITY_ID) ?? getString(data.crm_entity_id);
  const dealId = crmEntityType === "DEAL" ? crmEntityId : null;

  const status = computeStatus(data);

  return {
    manager_bitrix_user_id: managerUserId,
    bitrix_deal_id: dealId,
    phone,
    status,
    crm_activity_id: crmActivityId,
    bitrix_call_id: bitrixCallId,
    occurred_at: new Date().toISOString(),
    raw_payload: payload
  };
}

