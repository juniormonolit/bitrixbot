import { normalizeBitrixUserId } from "@/src/lib/bitrixbot/bitrix-user-id";

type JsonObject = Record<string, unknown>;

export type ExtractedCallContext = {
  phoneNormalized: string | null;
  managerBitrixUserId: string | null;
  dealId: number | null;
  contactName: string | null;
};

type CallEventRow = {
  phone_normalized: string | null;
  manager_bitrix_user_id: string | null;
  bitrix_deal_id: string | null;
  raw_payload: unknown;
};

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

/** Bitrix CRM: deal owner type id (same as lib/bitrix/call-normalize). */
const OWNER_TYPE_DEAL = 2;

function isDealCrmEntity(data: JsonObject): boolean {
  const s = (getString(data.CRM_ENTITY_TYPE) ?? getString(data.crm_entity_type))?.toUpperCase() ?? "";
  if (s === "DEAL") return true;
  const n = getNumber(data.CRM_ENTITY_TYPE) ?? getNumber(data.crm_entity_type);
  return n === OWNER_TYPE_DEAL;
}

function parseDealId(value: string | null): number | null {
  if (!value) return null;
  const v = value.trim();
  if (!/^\d{1,12}$/.test(v)) return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) return null;
  return n;
}

export function extractCallContext(callEvent: CallEventRow): ExtractedCallContext {
  const fromColumns = {
    phoneNormalized: callEvent.phone_normalized ?? null,
    managerBitrixUserId: callEvent.manager_bitrix_user_id ?? null,
    dealId: parseDealId(callEvent.bitrix_deal_id ?? null),
    contactName: null as string | null
  };

  const root = getObj(callEvent.raw_payload);
  const data = getObj(root.data ?? root.DATA);

  const dealIdFromPayload = isDealCrmEntity(data)
    ? parseDealId(getString(data.CRM_ENTITY_ID) ?? getString(data.crm_entity_id))
    : null;

  const dealId = fromColumns.dealId ?? dealIdFromPayload;

  const contactName =
    getString(data.CONTACT_NAME) ?? getString(data.contact_name) ?? fromColumns.contactName;

  return {
    phoneNormalized: fromColumns.phoneNormalized,
    managerBitrixUserId: normalizeBitrixUserId(fromColumns.managerBitrixUserId),
    dealId,
    contactName
  };
}
