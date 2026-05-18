type JsonObject = Record<string, unknown>;

export type NormalizedDealEvent = {
  event_name: "ONCRMDEALADD" | "ONCRMDEALUPDATE";
  bitrix_deal_id: string;
  stage_id: string | null;
  category_id: string | null;
  assigned_by_id: string | null;
  created_by_id: string | null;
  title: string | null;
  opportunity: number | null;
  currency: string | null;
  is_new: boolean;
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

function pickDealId(root: JsonObject): string | null {
  const data = getObj(root.data ?? root.DATA);
  const fieldsUpper = getObj(data.FIELDS);
  const fieldsLower = getObj(data.fields);

  return (
    // required priority:
    getString(fieldsUpper.ID) ??
    getString(fieldsLower.id) ??
    getString(data.ID) ??
    getString(root.ID)
  );
}

export function normalizeBitrixDealEvent(
  eventName: string,
  payload: unknown
): NormalizedDealEvent | null {
  if (eventName !== "ONCRMDEALADD" && eventName !== "ONCRMDEALUPDATE") return null;

  const root = getObj(payload);
  const data = getObj(root.data ?? root.DATA);
  const fields = getObj(data.FIELDS ?? data.fields);

  const dealId = pickDealId(root);
  if (!dealId) return null;

  const opportunity = getNumber(fields.OPPORTUNITY ?? fields.opportunity);

  return {
    event_name: eventName,
    bitrix_deal_id: dealId,
    stage_id: getString(fields.STAGE_ID ?? fields.stage_id),
    category_id: getString(fields.CATEGORY_ID ?? fields.category_id),
    assigned_by_id: getString(fields.ASSIGNED_BY_ID ?? fields.assigned_by_id),
    created_by_id: getString(fields.CREATED_BY_ID ?? fields.created_by_id),
    title: getString(fields.TITLE ?? fields.title),
    opportunity,
    currency: getString(fields.CURRENCY_ID ?? fields.currency_id ?? fields.CURRENCY ?? fields.currency),
    is_new: eventName === "ONCRMDEALADD",
    occurred_at: new Date().toISOString(),
    raw_payload: payload
  };
}

export type NormalizedDealDeleteEvent = {
  event_name: "ONCRMDEALDELETE";
  bitrix_deal_id: string;
  occurred_at: string;
  raw_payload: unknown;
};

export function normalizeBitrixDealDeleteEvent(eventName: string, payload: unknown): NormalizedDealDeleteEvent | null {
  if (eventName !== "ONCRMDEALDELETE") return null;
  const root = getObj(payload);
  const data = getObj(root.data ?? root.DATA);
  const fields = getObj(data.FIELDS ?? data.fields);
  const dealId =
    getString(fields.ID ?? fields.id) ?? getString(data.ID) ?? pickDealId(root);
  if (!dealId) return null;
  return {
    event_name: "ONCRMDEALDELETE",
    bitrix_deal_id: dealId,
    occurred_at: new Date().toISOString(),
    raw_payload: payload
  };
}

