import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { extractVoximplantDataPayload } from "@/src/lib/bitrixbot/voximplant-inbound-missed";

const LOG = "[activity-deal-mapping]";
const PHONE_FALLBACK_LIMIT = 200;
const DEFAULT_MAPPING_PHONE_FALLBACK_DAYS = 90;

/**
 * Env `MAPPING_PHONE_FALLBACK_DAYS` — limit phone fallback rows to `called_at` within this many days.
 * Invalid / missing → 90.
 */
export function parseMappingPhoneFallbackDays(): number {
  const raw = process.env.MAPPING_PHONE_FALLBACK_DAYS;
  if (raw == null || String(raw).trim() === "") return DEFAULT_MAPPING_PHONE_FALLBACK_DAYS;
  const n = Number(String(raw).trim());
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1) return DEFAULT_MAPPING_PHONE_FALLBACK_DAYS;
  return n;
}

export function getMappingPhoneFallbackCalledAtFromIso(): string {
  const days = parseMappingPhoneFallbackDays();
  return new Date(Date.now() - days * 86_400_000).toISOString();
}

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
 * optional `MAPPING_SUPABASE_SCHEMA` (default `public`), `MAPPING_SUPABASE_TABLE` (default `bitrix_activity_deals`),
 * optional `MAPPING_PHONE_FALLBACK_DAYS` (default `90`) — для phone fallback только строки с `called_at` не старше N дней.
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

export type DealMappingResolutionSource = "activity_id" | "phone_manager" | "phone_only" | null;

/** Normalized winning mapping row for logs / check script. */
export type ResolvedDealMappingMatchedRow = {
  bitrix_activity_id: number | null;
  deal_id: number | null;
  phone_number: string | null;
  called_at: string | null;
  manager_id: number | null;
};

export type ResolveDealMappingResult = {
  dealId: number | null;
  source: DealMappingResolutionSource;
  confidence: number | null;
  matched_bitrix_activity_id: number | null;
  matched_called_at: string | null;
  matched_by_phone: boolean | null;
  phone_manager_matched: boolean | null;
  multiple_deals_by_phone: boolean;
  fallback_days: number;
  called_at_from: string | null;
  queryErrors: string[];
  matched_row: ResolvedDealMappingMatchedRow | null;
};

function baseMappingMeta(): Pick<ResolveDealMappingResult, "fallback_days" | "called_at_from"> {
  const fallback_days = parseMappingPhoneFallbackDays();
  const called_at_from = new Date(Date.now() - fallback_days * 86_400_000).toISOString();
  return { fallback_days, called_at_from };
}

function unresolvedMappingResult(
  meta: Pick<ResolveDealMappingResult, "fallback_days" | "called_at_from">,
  queryErrors: string[]
): ResolveDealMappingResult {
  return {
    dealId: null,
    source: null,
    confidence: null,
    matched_bitrix_activity_id: null,
    matched_called_at: null,
    matched_by_phone: null,
    phone_manager_matched: null,
    multiple_deals_by_phone: false,
    ...meta,
    queryErrors,
    matched_row: null
  };
}

function parseManagerIdFromMappingRow(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number" && Number.isFinite(value) && Number.isInteger(value)) {
    if (!Number.isSafeInteger(value)) return null;
    return value;
  }
  if (typeof value === "bigint") {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : null;
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!/^\d{1,18}$/.test(s)) return null;
    const n = Number(s);
    return Number.isSafeInteger(n) ? n : null;
  }
  return null;
}

function toMatchedRow(r: {
  bitrix_activity_id?: unknown;
  deal_id?: unknown;
  phone_number?: string | null;
  called_at?: string | null;
  manager_id?: unknown;
}): ResolvedDealMappingMatchedRow {
  return {
    bitrix_activity_id: parseBitrixActivityIdForMapping(r.bitrix_activity_id),
    deal_id: parseDealIdFromMappingRow(r.deal_id),
    phone_number: r.phone_number ?? null,
    called_at: r.called_at ?? null,
    manager_id: parseManagerIdFromMappingRow(r.manager_id)
  };
}

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
 * Phone fallback is limited to rows with `called_at >= now - MAPPING_PHONE_FALLBACK_DAYS` (default 90).
 */
export async function resolveDealMapping(input: {
  activityIdNum: number | null;
  crm_activity_id?: string | null;
  phone_normalized?: string | null;
  manager_bitrix_user_id?: string | null;
}): Promise<ResolveDealMappingResult> {
  const meta = baseMappingMeta();
  const queryErrors: string[] = [];

  const cfg = getActivityDealMappingConfig();
  const client = getMappingDbClient();
  if (!cfg || !client) {
    return unresolvedMappingResult(meta, queryErrors);
  }

  const mappingCfg: ActivityDealMappingConfig = cfg;
  const dbClient = client;

  const crmLog = input.crm_activity_id ?? null;

  if (input.activityIdNum != null) {
    const normalizedLookupId =
      normalizeCrmActivityIdForLookup(input.activityIdNum) ?? String(input.activityIdNum);

    const { data, error } = await fromMappingTable(dbClient, mappingCfg)
      .select("deal_id, bitrix_activity_id, called_at")
      .eq("bitrix_activity_id", normalizedLookupId)
      .limit(2);

    let foundDealId: number | null = null;
    let firstRow: { deal_id?: unknown; bitrix_activity_id?: unknown; called_at?: string | null } | null = null;
    if (error) {
      queryErrors.push(`activity_lookup: ${error.message}`);
      console.error(`${LOG} query_failed`, {
        activity_id: input.activityIdNum,
        crm_activity_id: crmLog,
        mapping_schema: mappingCfg.schema,
        mapping_table: mappingCfg.table,
        message: error.message
      });
    } else {
      const rows = (data ?? []) as Array<{
        deal_id?: unknown;
        bitrix_activity_id?: unknown;
        called_at?: string | null;
      }>;
      if (rows.length > 1) {
        console.warn(`${LOG} multiple_rows_using_first`, {
          activity_id: input.activityIdNum,
          count: rows.length
        });
      }
      if (rows.length > 0) {
        firstRow = rows[0] ?? null;
        foundDealId = parseDealIdFromMappingRow(firstRow?.deal_id);
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

    if (foundDealId != null && firstRow) {
      const matchedRow = toMatchedRow({
        ...firstRow,
        phone_number: null,
        manager_id: null
      });
      return {
        dealId: foundDealId,
        source: "activity_id",
        confidence: 1.0,
        matched_bitrix_activity_id:
          matchedRow.bitrix_activity_id ?? parseBitrixActivityIdForMapping(input.activityIdNum),
        matched_called_at: matchedRow.called_at,
        matched_by_phone: false,
        phone_manager_matched: false,
        multiple_deals_by_phone: false,
        ...meta,
        queryErrors,
        matched_row: matchedRow
      };
    }
  }

  const targetPhone = normalizePhoneForMappingLookup(input.phone_normalized);
  if (!targetPhone) {
    return unresolvedMappingResult(meta, queryErrors);
  }

  const mgr = parseManagerIdForMappingFilter(input.manager_bitrix_user_id);

  async function runPhoneQuery(withManager: boolean): Promise<{
    rows: MappingPhoneRow[];
    errorMsg: string | null;
  }> {
    let q = fromMappingTable(dbClient, mappingCfg)
      .select("bitrix_activity_id, deal_id, manager_id, phone_number, called_at")
      .not("phone_number", "is", null)
      .gte("called_at", meta.called_at_from)
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

  let managerPassOkNoPhoneMatch = false;

  if (mgr != null) {
    const r1 = await runPhoneQuery(true);
    if (r1.errorMsg) {
      queryErrors.push(`phone_fallback_manager: ${r1.errorMsg}`);
    } else {
      const m1 = filterRowsByNormalizedPhone(r1.rows, targetPhone);
      if (m1.length > 0) {
        return finalizePhoneFallback(input, targetPhone, r1.rows, m1, true, meta, queryErrors);
      }
      managerPassOkNoPhoneMatch = true;
    }
  }

  const r2 = await runPhoneQuery(false);
  if (r2.errorMsg) {
    queryErrors.push(`phone_fallback: ${r2.errorMsg}`);
  }

  const candidates = r2.rows;
  const matches = filterRowsByNormalizedPhone(candidates, targetPhone);

  if (
    matches.length > 0 &&
    mgr != null &&
    managerPassOkNoPhoneMatch &&
    r2.errorMsg == null
  ) {
    console.warn(`${LOG} activity_mapping_phone_fallback_without_manager_match`, {
      phone_normalized: targetPhone,
      manager_bitrix_user_id: input.manager_bitrix_user_id ?? null
    });
  }

  return finalizePhoneFallback(input, targetPhone, candidates, matches, false, meta, queryErrors);
}

function finalizePhoneFallback(
  input: {
    crm_activity_id?: string | null;
    manager_bitrix_user_id?: string | null;
  },
  targetPhone: string,
  candidates: MappingPhoneRow[],
  matches: MappingPhoneRow[],
  managerFilterUsed: boolean,
  meta: Pick<ResolveDealMappingResult, "fallback_days" | "called_at_from">,
  priorQueryErrors: string[]
): ResolveDealMappingResult {
  const crmLog = input.crm_activity_id ?? null;
  const queryErrors = [...priorQueryErrors];

  const matchedCount = matches.length;
  let foundDealId: number | null = null;
  let matchedActivityId: number | null = null;
  let matchedAt: string | null = null;
  let winner: MappingPhoneRow | null = null;
  let multipleDeals = false;

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
    multipleDeals = dealIds.size > 1;
    if (multipleDeals) {
      console.warn(`${LOG} activity_mapping_phone_multiple_deals`, {
        phone_normalized: targetPhone,
        deal_ids: [...dealIds],
        row_count: sorted.length
      });
    }

    winner = sorted[0] ?? null;
    foundDealId = parseDealIdFromMappingRow(winner?.deal_id);
    matchedActivityId = parseBitrixActivityIdForMapping(winner?.bitrix_activity_id);
    matchedAt = winner?.called_at ?? null;
  }

  const confidence =
    foundDealId == null ? null : multipleDeals ? 0.3 : managerFilterUsed ? 0.9 : 0.6;
  const source: "phone_manager" | "phone_only" | null =
    foundDealId == null ? null : managerFilterUsed ? "phone_manager" : "phone_only";

  console.log(`${LOG} activity_mapping_phone_fallback`, {
    source: source ?? "phone_unresolved",
    crm_activity_id: crmLog,
    phone_normalized: targetPhone,
    manager_bitrix_user_id: input.manager_bitrix_user_id ?? null,
    candidate_count: candidates.length,
    matched_count: matchedCount,
    found_deal_id: foundDealId,
    matched_bitrix_activity_id: matchedActivityId,
    matched_called_at: matchedAt,
    manager_filter_used: managerFilterUsed,
    confidence,
    multiple_deals_by_phone: multipleDeals,
    fallback_days: meta.fallback_days,
    called_at_from: meta.called_at_from,
    query_errors: queryErrors
  });

  if (foundDealId == null) {
    return unresolvedMappingResult(meta, queryErrors);
  }

  const matched_row = winner ? toMatchedRow(winner) : null;
  return {
    dealId: foundDealId,
    source,
    confidence,
    matched_bitrix_activity_id: matchedActivityId,
    matched_called_at: matchedAt,
    matched_by_phone: true,
    phone_manager_matched: managerFilterUsed,
    multiple_deals_by_phone: multipleDeals,
    ...meta,
    queryErrors,
    matched_row
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
