import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { extractVoximplantDataPayload } from "@/src/lib/bitrixbot/voximplant-inbound-missed";

const LOG = "[activity-deal-mapping]";
const PHONE_FALLBACK_LIMIT = 200;

let _mappingClient: SupabaseClient | null | undefined;
let _missingEnvWarned = false;

function warnMappingDisabledOnce(): void {
  if (_missingEnvWarned) return;
  _missingEnvWarned = true;
  console.warn("Activity-deal mapping disabled: env vars missing");
}

/**
 * Canonical RU mobile digits for matching `call_events.phone_normalized` ↔ `va.calls.phone_number`:
 * strip non-digits; 11 chars starting with 8 → 7+rest; 11 starting with 7 → as is; 10 chars → 7+all.
 */
export function normalizePhoneForMappingLookup(phone: string | null | undefined): string | null {
  if (phone == null) return null;
  const digits = String(phone).replace(/\D/g, "");
  if (!digits) return null;

  if (digits.length === 11 && digits.startsWith("8")) {
    return `7${digits.slice(1)}`;
  }
  if (digits.length === 11 && digits.startsWith("7")) {
    return digits;
  }
  if (digits.length === 10) {
    return `7${digits}`;
  }
  return null;
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
  /** PostgREST schema (exposed in API). Default `public`. */
  schema: string;
  table: string;
};

/**
 * Optional external Supabase with rows: `bitrix_activity_id` → `deal_id`.
 * Env: `MAPPING_SUPABASE_URL`, `MAPPING_SUPABASE_SERVICE_ROLE_KEY`,
 * optional `MAPPING_SUPABASE_SCHEMA` (default `public`), `MAPPING_SUPABASE_TABLE` (default `bitrix_activity_deals`).
 */
export function getActivityDealMappingConfig(): ActivityDealMappingConfig | null {
  const url = (process.env.MAPPING_SUPABASE_URL ?? "").trim();
  const serviceKey = (process.env.MAPPING_SUPABASE_SERVICE_ROLE_KEY ?? "").trim();
  const schemaRaw = (process.env.MAPPING_SUPABASE_SCHEMA ?? "public").trim();
  const schema = schemaRaw === "" ? "public" : schemaRaw;
  const table = (process.env.MAPPING_SUPABASE_TABLE ?? "bitrix_activity_deals").trim();

  if (!url || !serviceKey) {
    warnMappingDisabledOnce();
    return null;
  }

  return { url, serviceKey, schema, table };
}

function fromMappingTable(client: SupabaseClient, cfg: ActivityDealMappingConfig) {
  return cfg.schema === "public" ? client.from(cfg.table) : client.schema(cfg.schema).from(cfg.table);
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
  if (typeof value === "bigint") {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) return null;
    return n;
  }
  return null;
}

export function parseManagerIdForMappingFilter(raw: string | null | undefined): number | null {
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || !Number.isSafeInteger(n)) return null;
  return n;
}

export type ResolveDealIdLogContext = {
  /** Raw `crm_activity_id` from `call_events` or payload (before numeric parse). */
  crm_activity_id?: string | null;
};

export type ResolveDealMappingResult = {
  dealId: number | null;
  source: "activity_id" | "phone" | null;
  matched_bitrix_activity_id?: number | null;
  matched_called_at?: string | null;
};

type MappingPhoneRow = {
  bitrix_activity_id?: unknown;
  deal_id?: unknown;
  manager_id?: unknown;
  phone_number: string | null;
  called_at: string | null;
};

function filterRowsByNormalizedPhone(rows: MappingPhoneRow[], targetNormalized: string): MappingPhoneRow[] {
  return rows.filter((r) => normalizePhoneForMappingLookup(r.phone_number) === targetNormalized);
}

/**
 * Try activity_id, then phone history (newest `called_at` first), optional manager_id filter then without.
 */
export async function resolveDealMapping(input: {
  activityIdNum: number | null;
  crm_activity_id?: string | null;
  phone_normalized?: string | null;
  manager_bitrix_user_id?: string | null;
}): Promise<ResolveDealMappingResult> {
  const cfg = getActivityDealMappingConfig();
  const client = getMappingDbClient();
  if (!cfg || !client) {
    return { dealId: null, source: null };
  }

  const mappingCfg: ActivityDealMappingConfig = cfg;
  const dbClient = client;

  const crmLog = input.crm_activity_id ?? null;

  if (input.activityIdNum != null) {
    const normalizedLookupId =
      normalizeCrmActivityIdForLookup(input.activityIdNum) ?? String(input.activityIdNum);

    const { data, error } = await fromMappingTable(dbClient, mappingCfg)
      .select("deal_id")
      .eq("bitrix_activity_id", normalizedLookupId)
      .limit(2);

    let foundDealId: number | null = null;
    if (error) {
      console.error(`${LOG} query_failed`, {
        activity_id: input.activityIdNum,
        crm_activity_id: crmLog,
        mapping_schema: mappingCfg.schema,
        mapping_table: mappingCfg.table,
        message: error.message
      });
    } else {
      const rows = (data ?? []) as Array<{ deal_id?: unknown }>;
      if (rows.length > 1) {
        console.warn(`${LOG} multiple_rows_using_first`, {
          activity_id: input.activityIdNum,
          count: rows.length
        });
      }
      if (rows.length > 0) {
        foundDealId = parseDealIdFromMappingRow(rows[0]?.deal_id);
      }
    }

    console.log(`${LOG} activity_mapping_lookup`, {
      source: "activity_id" as const,
      crm_activity_id: crmLog,
      normalized_lookup_id: normalizedLookupId,
      mapping_schema: mappingCfg.schema,
      mapping_table: mappingCfg.table,
      filter_column: "bitrix_activity_id",
      found_deal_id: foundDealId,
      query_error: error ? error.message : null
    });

    if (foundDealId != null) {
      return { dealId: foundDealId, source: "activity_id" };
    }
  }

  const targetPhone = normalizePhoneForMappingLookup(input.phone_normalized);
  if (!targetPhone) {
    return { dealId: null, source: null };
  }

  const mgr = parseManagerIdForMappingFilter(input.manager_bitrix_user_id);

  async function runPhoneQuery(withManager: boolean): Promise<{
    rows: MappingPhoneRow[];
    errorMsg: string | null;
  }> {
    let q = fromMappingTable(dbClient, mappingCfg)
      .select("bitrix_activity_id, deal_id, manager_id, phone_number, called_at")
      .not("phone_number", "is", null)
      .order("called_at", { ascending: false })
      .limit(PHONE_FALLBACK_LIMIT);

    if (withManager && mgr != null) {
      q = q.eq("manager_id", mgr);
    }

    const { data, error } = await q;
    if (error) {
      return { rows: [], errorMsg: error.message };
    }
    return { rows: (data ?? []) as MappingPhoneRow[], errorMsg: null };
  }

  let queryError: string | null = null;
  let managerPassOkNoPhoneMatch = false;

  if (mgr != null) {
    const r1 = await runPhoneQuery(true);
    if (r1.errorMsg) {
      queryError = r1.errorMsg;
    } else {
      const m1 = filterRowsByNormalizedPhone(r1.rows, targetPhone);
      if (m1.length > 0) {
        return finalizePhoneFallback(
          input,
          mappingCfg,
          targetPhone,
          r1.rows,
          m1,
          true,
          null
        );
      }
      managerPassOkNoPhoneMatch = true;
    }
  }

  const r2 = await runPhoneQuery(false);
  if (r2.errorMsg) {
    queryError = queryError ?? r2.errorMsg;
  }

  const candidates = r2.rows;
  const matches = filterRowsByNormalizedPhone(candidates, targetPhone);

  if (
    matches.length > 0 &&
    mgr != null &&
    managerPassOkNoPhoneMatch &&
    queryError == null
  ) {
    console.warn(`${LOG} activity_mapping_phone_fallback_without_manager_match`, {
      phone_normalized: targetPhone,
      manager_bitrix_user_id: input.manager_bitrix_user_id ?? null
    });
  }

  return finalizePhoneFallback(
    input,
    mappingCfg,
    targetPhone,
    candidates,
    matches,
    false,
    r2.errorMsg
  );
}

function finalizePhoneFallback(
  input: {
    crm_activity_id?: string | null;
    manager_bitrix_user_id?: string | null;
  },
  cfg: ActivityDealMappingConfig,
  targetPhone: string,
  candidates: MappingPhoneRow[],
  matches: MappingPhoneRow[],
  managerFilterUsed: boolean,
  queryError: string | null
): ResolveDealMappingResult {
  const crmLog = input.crm_activity_id ?? null;

  const matchedCount = matches.length;
  let foundDealId: number | null = null;
  let matchedActivityId: number | null = null;
  let matchedAt: string | null = null;

  if (matchedCount > 0) {
    const sorted = [...matches].sort((a, b) => {
      const ta = a.called_at ? new Date(a.called_at).getTime() : 0;
      const tb = b.called_at ? new Date(b.called_at).getTime() : 0;
      return tb - ta;
    });

    const dealIds = new Set<number>();
    for (const m of sorted) {
      const d = parseDealIdFromMappingRow(m.deal_id);
      if (d != null) dealIds.add(d);
    }
    if (dealIds.size > 1) {
      console.warn(`${LOG} activity_mapping_phone_multiple_deals`, {
        phone_normalized: targetPhone,
        deal_ids: [...dealIds],
        row_count: sorted.length
      });
    }

    const winner = sorted[0];
    foundDealId = parseDealIdFromMappingRow(winner?.deal_id);
    matchedActivityId = parseBitrixActivityIdForMapping(winner?.bitrix_activity_id);
    matchedAt = winner?.called_at ?? null;
  }

  console.log(`${LOG} activity_mapping_phone_fallback`, {
    source: "phone" as const,
    crm_activity_id: crmLog,
    phone_normalized: targetPhone,
    manager_bitrix_user_id: input.manager_bitrix_user_id ?? null,
    candidate_count: candidates.length,
    matched_count: matchedCount,
    found_deal_id: foundDealId,
    matched_bitrix_activity_id: matchedActivityId,
    matched_called_at: matchedAt,
    manager_filter_used: managerFilterUsed,
    query_error: queryError
  });

  if (foundDealId == null) {
    return { dealId: null, source: null };
  }
  return {
    dealId: foundDealId,
    source: "phone",
    matched_bitrix_activity_id: matchedActivityId,
    matched_called_at: matchedAt
  };
}

/**
 * Legacy: activity id only (no phone fallback). Prefer `resolveDealMapping`.
 */
export async function resolveDealIdByActivityId(
  activityId: number,
  logCtx?: ResolveDealIdLogContext | null
): Promise<number | null> {
  const r = await resolveDealMapping({
    activityIdNum: activityId,
    crm_activity_id: logCtx?.crm_activity_id ?? null,
    phone_normalized: null,
    manager_bitrix_user_id: null
  });
  return r.dealId;
}

/** Alias matching integration docs (`resolveDealId(activityId)`). */
export const resolveDealId = resolveDealIdByActivityId;
