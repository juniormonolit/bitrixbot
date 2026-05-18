import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { extractVoximplantDataPayload } from "@/lib/bitrixbot/voximplant-inbound-missed";

const LOG = "[activity-deal-mapping]";

let _mappingClient: SupabaseClient | null | undefined;
let _missingEnvWarned = false;

function warnMappingDisabledOnce(): void {
  if (_missingEnvWarned) return;
  _missingEnvWarned = true;
  console.warn("Activity-deal mapping disabled: env vars missing");
}

function getString(value: unknown): string | null {
  if (typeof value === "string") {
    const v = value.trim();
    return v ? v : null;
  }
  if (typeof value === "number") return String(value);
  return null;
}

/**
 * Bitrix `CRM_ACTIVITY_ID` in webhooks is a numeric string (DB column may be int8 or text).
 * Prefer an indexed `bitrix_activity_id` column on the mapping table for fast lookups.
 */
export function parseBitrixActivityIdForMapping(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!/^\d{1,18}$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n) || !Number.isSafeInteger(n)) return null;
  return n;
}

/**
 * CRM activity id for mapping: DB column first, then `data` / `DATA` from webhook
 * (`CRM_ACTIVITY_ID` / `crm_activity_id`).
 */
export function getCrmActivityIdForDealMapping(
  column: string | null | undefined,
  rawPayload: unknown
): string | null {
  const c = column?.trim() ?? "";
  if (c) return c;
  const data = extractVoximplantDataPayload(rawPayload);
  return getString(data.CRM_ACTIVITY_ID) ?? getString(data.crm_activity_id);
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

/**
 * Resolve Bitrix deal id for a call activity via external mapping DB only (no Bitrix CRM REST).
 * Not finding a row is normal — returns null.
 */
export async function resolveDealIdByActivityId(activityId: number): Promise<number | null> {
  const cfg = getActivityDealMappingConfig();
  if (!cfg) return null;

  const client = getMappingDbClient();
  if (!client) return null;

  /** String value works for PostgREST on int8 or text columns. */
  const activityKey = String(activityId);
  const { data, error } = await client
    .from(cfg.table)
    .select("deal_id")
    .eq("bitrix_activity_id", activityKey)
    .limit(2);

  if (error) {
    console.error(`${LOG} query_failed`, { activity_id: activityId, message: error.message });
    return null;
  }

  const rows = (data ?? []) as Array<{ deal_id?: unknown }>;
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    console.warn(`${LOG} multiple_rows_using_first`, { activity_id: activityId, count: rows.length });
  }

  return parseDealIdFromMappingRow(rows[0]?.deal_id);
}

/** Alias matching integration docs (`resolveDealId(activityId)`). */
export const resolveDealId = resolveDealIdByActivityId;
