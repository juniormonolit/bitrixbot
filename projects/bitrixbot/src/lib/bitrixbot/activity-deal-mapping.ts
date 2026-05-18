import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { extractVoximplantDataPayload } from "@/src/lib/bitrixbot/voximplant-inbound-missed";

const LOG = "[activity-deal-mapping]";

let _mappingClient: SupabaseClient | null | undefined;
let _missingEnvWarned = false;

function warnMappingDisabledOnce(): void {
  if (_missingEnvWarned) return;
  _missingEnvWarned = true;
  console.warn("Activity-deal mapping disabled: env vars missing");
}

/**
 * Coerce `call_events.crm_activity_id` (PostgREST may return string, number, or bigint)
 * and webhook payload fields to a canonical digit string for lookup against
 * external `mapping.bitrix_activity_id`.
 */
export function normalizeCrmActivityIdForLookup(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "bigint") {
    const s = value.toString();
    return /^\d{1,18}$/.test(s) ? s : null;
  }
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) return null;
    return String(value);
  }
  if (typeof value === "string") {
    const t = value.trim().replace(/\s+/g, "");
    if (!t) return null;
    if (!/^\d{1,18}$/.test(t)) return null;
    return t;
  }
  return null;
}

/**
 * Bitrix `CRM_ACTIVITY_ID` in webhooks is a numeric string (DB column may be int8 or text).
 * Prefer an indexed `bitrix_activity_id` column on the mapping table for fast lookups.
 * Lookup equality: `call_events.crm_activity_id` (normalized) → `mapping.bitrix_activity_id`.
 */
export function parseBitrixActivityIdForMapping(raw: unknown): number | null {
  const s = normalizeCrmActivityIdForLookup(raw);
  if (!s) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) return null;
  return n;
}

/**
 * CRM activity id for mapping: `call_events.crm_activity_id` first, then `data` / `DATA` from webhook
 * (`CRM_ACTIVITY_ID` / `crm_activity_id`).
 */
export function getCrmActivityIdForDealMapping(column: unknown, rawPayload: unknown): string | null {
  const fromCol = normalizeCrmActivityIdForLookup(column);
  if (fromCol) return fromCol;
  const data = extractVoximplantDataPayload(rawPayload);
  return (
    normalizeCrmActivityIdForLookup(data.CRM_ACTIVITY_ID) ??
    normalizeCrmActivityIdForLookup(data.crm_activity_id)
  );
}

export type ActivityDealMappingConfig = {
  url: string;
  serviceKey: string;
  table: string;
};

/**
 * Optional external Supabase with rows: `bitrix_activity_id` → `deal_id`.
 * Uses only `MAPPING_SUPABASE_URL` + `MAPPING_SUPABASE_SERVICE_ROLE_KEY` (+ optional `MAPPING_SUPABASE_TABLE`).
 */
export function getActivityDealMappingConfig(): ActivityDealMappingConfig | null {
  const url = (process.env.MAPPING_SUPABASE_URL ?? "").trim();
  const serviceKey = (process.env.MAPPING_SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const table = (process.env.MAPPING_SUPABASE_TABLE ?? "bitrix_activity_deals").trim();

  if (!url || !serviceKey) {
    warnMappingDisabledOnce();
    return null;
  }

  return { url, serviceKey, table };
}

export function isActivityDealMappingConfigured(): boolean {
  return getActivityDealMappingConfig() !== null;
}

/** @internal Dev / manual checks only — resets one-shot warning and cached client. */
export function __resetActivityDealMappingModuleForDev(): void {
  _mappingClient = undefined;
  _missingEnvWarned = false;
}

export function getMappingDbClient(): SupabaseClient | null {
  const cfg = getActivityDealMappingConfig();
  if (!cfg) return null;
  if (_mappingClient !== undefined) return _mappingClient;
  _mappingClient = createClient(cfg.url, cfg.serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }
  });
  return _mappingClient;
}

function parseDealIdFromMappingRow(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) return null;
    return value;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!/^\d{1,18}$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || !Number.isSafeInteger(n)) return null;
    return n;
  }
  return null;
}

export type ResolveDealIdLogContext = {
  /** Raw `crm_activity_id` from `call_events` or payload (before numeric parse). */
  crm_activity_id?: string | null;
};

/**
 * Resolve Bitrix deal id for a call activity via external mapping DB only (no Bitrix CRM REST).
 * Filters with `.eq("bitrix_activity_id", …)` — must match `call_events.crm_activity_id` (normalized).
 * Not finding a row is normal — returns null.
 */
export async function resolveDealIdByActivityId(
  activityId: number,
  logCtx?: ResolveDealIdLogContext | null
): Promise<number | null> {
  const cfg = getActivityDealMappingConfig();
  if (!cfg) return null;

  const client = getMappingDbClient();
  if (!client) return null;

  /** String filter works for PostgREST against int8, int4, and text columns. */
  const normalizedLookupId = normalizeCrmActivityIdForLookup(activityId) ?? String(activityId);

  const { data, error } = await client
    .from(cfg.table)
    .select("deal_id")
    .eq("bitrix_activity_id", normalizedLookupId)
    .limit(2);

  let foundDealId: number | null = null;
  if (error) {
    console.error(`${LOG} query_failed`, { activity_id: activityId, message: error.message });
  } else {
    const rows = (data ?? []) as Array<{ deal_id?: unknown }>;
    if (rows.length > 1) {
      console.warn(`${LOG} multiple_rows_using_first`, { activity_id: activityId, count: rows.length });
    }
    if (rows.length > 0) {
      foundDealId = parseDealIdFromMappingRow(rows[0]?.deal_id);
    }
  }

  console.log(`${LOG} activity_mapping_lookup`, {
    crm_activity_id: logCtx?.crm_activity_id ?? null,
    normalized_lookup_id: normalizedLookupId,
    mapping_table: cfg.table,
    filter_column: "bitrix_activity_id",
    found_deal_id: foundDealId,
    query_error: error ? error.message : null
  });

  if (error) return null;
  return foundDealId;
}

/** Alias matching integration docs (`resolveDealId(activityId)`). */
export const resolveDealId = resolveDealIdByActivityId;
