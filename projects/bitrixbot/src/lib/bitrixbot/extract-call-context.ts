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

function parseDealId(value: string | null): number | null {
  if (!value) return null;
  const v = value.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

export function extractCallContext(callEvent: CallEventRow): ExtractedCallContext {
  const fromColumns = {
    phoneNormalized: callEvent.phone_normalized ?? null,
    managerBitrixUserId: callEvent.manager_bitrix_user_id ?? null,
    dealId: parseDealId(callEvent.bitrix_deal_id ?? null),
    contactName: null as string | null
  };

  // Try to enrich from raw_payload without guessing unknown fields.
  const root = getObj(callEvent.raw_payload);
  const data = getObj(root.data ?? root.DATA);

  const dealId =
    fromColumns.dealId ??
    parseDealId(getString(data.CRM_ENTITY_ID) ?? getString(data.crm_entity_id));

  // contact name is not known to be present yet; keep null unless explicitly found.
  const contactName =
    getString(data.CONTACT_NAME) ?? getString(data.contact_name) ?? fromColumns.contactName;

  return {
    phoneNormalized: fromColumns.phoneNormalized,
    managerBitrixUserId: normalizeBitrixUserId(fromColumns.managerBitrixUserId),
    dealId,
    contactName
  };
}

