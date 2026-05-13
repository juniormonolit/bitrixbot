import { createServiceRoleClient } from "@/lib/supabase/server";
import { normalizeBitrixUserId } from "@/src/lib/bitrixbot/bitrix-user-id";
import {
  upsertMissedCallCaseFromEvent,
  type UpsertMissedCallCaseResult
} from "@/src/lib/bitrixbot/upsert-missed-call-case-from-event";

const LOG = "[alerting:process-missed-calls]";

type CallEventRow = {
  id: string;
  occurred_at: string;
  phone_normalized: string | null;
  manager_bitrix_user_id: string | null;
};

const DEFAULT_LIMIT = 100;
/** During diagnostics: cap work per run (was 500). */
const MAX_EFFECTIVE_LIMIT = 100;
const MAX_CANDIDATE_FETCH = 500;
const UPSERT_TIMEOUT_MS = 10_000;

export type EmployeeNotFoundAgg = {
  managerBitrixUserId: string | null;
  count: number;
  sampleCallEventIds: string[];
  samplePhones: string[];
};

export type UpsertFailureDiag = {
  callEventId: string;
  phone: string | null;
  managerBitrixUserId: string | null;
  occurredAt: string | null;
  timeoutMs: number;
  message: string;
  lastKnownStage: string;
};

function clampEffectiveLimit(limit: number | undefined): number {
  const raw =
    typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIMIT;
  if (raw < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_EFFECTIVE_LIMIT, raw);
}

function formatSupabaseError(
  ctx: string,
  err: { message: string; details?: string | null; hint?: string | null; code?: string | null }
): never {
  const parts = [err.message];
  if (err.details) parts.push(`details=${err.details}`);
  if (err.hint) parts.push(`hint=${err.hint}`);
  if (err.code) parts.push(`code=${err.code}`);
  throw new Error(`${ctx}: ${parts.join(" | ")}`);
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label}: timeout after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function mergeEmployeeNotFoundHit(
  map: Map<string, EmployeeNotFoundAgg>,
  hit: NonNullable<UpsertMissedCallCaseResult["employeeNotFoundHit"]>
) {
  const norm = normalizeBitrixUserId(hit.managerBitrixUserId);
  const mapKey = norm ?? "__null__";
  const cur =
    map.get(mapKey) ??
    ({
      managerBitrixUserId: norm,
      count: 0,
      sampleCallEventIds: [],
      samplePhones: []
    } as EmployeeNotFoundAgg);
  cur.count++;
  if (cur.sampleCallEventIds.length < 8) cur.sampleCallEventIds.push(hit.callEventId);
  const ph = hit.phone?.trim() || "";
  if (ph && cur.samplePhones.length < 8 && !cur.samplePhones.includes(ph)) cur.samplePhones.push(ph);
  map.set(mapKey, cur);
}

export type ProcessNewMissedCallEventsSummary = {
  scannedEvents: number;
  processedEvents: number;
  skippedEvents: number;
  failedEvents: number;
  createdCases: number;
  updatedCases: number;
  createdDeliveries: number;
  warnings: string[];
  /** Сгруппировано по manager Bitrix id (без дублей в сотнях строк). */
  employeeNotFound: EmployeeNotFoundAgg[];
  /** Таймауты / ошибки обёртки upsertMissedCallCaseFromEvent. */
  upsertFailures: UpsertFailureDiag[];
  /** Есть ли что показать как warning в UI (таймауты, failedEvents, missing employees). */
  issuesPresent: boolean;
  /** Rows returned from the missed+inbound query (bounded batch). */
  fetchedCandidateEvents: number;
  /** Among fetched candidates, how many already have `call_event_case_processing`. */
  alreadyProcessedCandidates: number;
  /** Among fetched candidates, how many are not in processing yet (before applying work limit). */
  unprocessedCandidates: number;
  /** Limit after clamp [1, 100]; this many events are passed to `upsertMissedCallCaseFromEvent` at most. */
  effectiveLimit: number;
};

export async function processNewMissedCallEvents(
  limit: number = DEFAULT_LIMIT
): Promise<ProcessNewMissedCallEventsSummary> {
  const supabase = createServiceRoleClient();
  const warnings: string[] = [];
  const employeeNotFoundMap = new Map<string, EmployeeNotFoundAgg>();
  const upsertFailures: UpsertFailureDiag[] = [];

  const effectiveLimit = clampEffectiveLimit(limit);
  const candidateFetchSize = Math.min(
    MAX_CANDIDATE_FETCH,
    Math.max(effectiveLimit * 10, effectiveLimit)
  );

  console.log(`${LOG} start`, { inputLimit: limit, effectiveLimit, candidateFetchSize });

  console.log(`${LOG} before candidate call_events query`);
  const { data: candidates, error: candErr } = await supabase
    .from("call_events")
    .select("id, occurred_at, phone_normalized, manager_bitrix_user_id")
    .eq("status", "missed")
    .eq("call_direction", "inbound")
    .order("occurred_at", { ascending: false })
    .limit(candidateFetchSize);

  if (candErr) {
    console.error(`${LOG} candidate call_events error`, candErr);
    formatSupabaseError("call_events.select(missed,inbound)", candErr);
  }
  const rows = (candidates ?? []) as CallEventRow[];
  console.log(`${LOG} after candidate call_events`, { count: rows.length, error: null });

  const fetchedCandidateEvents = rows.length;

  if (rows.length === 0) {
    const emptySummary: ProcessNewMissedCallEventsSummary = {
      scannedEvents: 0,
      processedEvents: 0,
      skippedEvents: 0,
      failedEvents: 0,
      createdCases: 0,
      updatedCases: 0,
      createdDeliveries: 0,
      warnings,
      employeeNotFound: [],
      upsertFailures: [],
      issuesPresent: false,
      fetchedCandidateEvents: 0,
      alreadyProcessedCandidates: 0,
      unprocessedCandidates: 0,
      effectiveLimit
    };
    console.log(`${LOG} finish summary (no candidates)`, emptySummary);
    return emptySummary;
  }

  const ids = rows.map((r) => r.id);
  console.log(`${LOG} before processing rows query`, { idCount: ids.length });
  const { data: processedRows, error: procErr } = await supabase
    .from("call_event_case_processing")
    .select("call_event_id")
    .in("call_event_id", ids);
  if (procErr) {
    console.error(`${LOG} processing rows error`, procErr);
    formatSupabaseError("call_event_case_processing.select", procErr);
  }
  console.log(`${LOG} after processing rows`, {
    count: (processedRows ?? []).length,
    error: null
  });

  const already = new Set<string>(
    (processedRows ?? []).map((r) => (r as { call_event_id: string }).call_event_id)
  );

  const alreadyProcessedCandidates = rows.filter((r) => already.has(r.id)).length;
  const unprocessedOrdered = rows.filter((r) => !already.has(r.id));
  const unprocessedCandidates = unprocessedOrdered.length;
  const toProcess = unprocessedOrdered.slice(0, effectiveLimit);

  console.log(`${LOG} toProcess`, {
    count: toProcess.length,
    fetchedCandidateEvents,
    alreadyProcessedCandidates,
    unprocessedCandidates,
    effectiveLimit
  });

  let processedEvents = 0;
  let skippedEvents = 0;
  let failedEvents = 0;
  let createdCases = 0;
  let updatedCases = 0;
  let createdDeliveries = 0;

  for (const ev of toProcess) {
    console.log(`${LOG} before upsert`, {
      callEventId: ev.id,
      occurred_at: ev.occurred_at,
      phone_normalized: ev.phone_normalized,
      manager_bitrix_user_id: ev.manager_bitrix_user_id,
      upsertTimeoutMs: UPSERT_TIMEOUT_MS
    });

    const diagCtx = { lastStage: "queued" };
    let res: Awaited<ReturnType<typeof upsertMissedCallCaseFromEvent>>;
    try {
      res = await withTimeout(
        upsertMissedCallCaseFromEvent(ev.id, diagCtx),
        UPSERT_TIMEOUT_MS,
        `upsert:${ev.id}`
      );
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      failedEvents++;
      const failure: UpsertFailureDiag = {
        callEventId: ev.id,
        phone: ev.phone_normalized,
        managerBitrixUserId: ev.manager_bitrix_user_id,
        occurredAt: ev.occurred_at,
        timeoutMs: UPSERT_TIMEOUT_MS,
        message: msg,
        lastKnownStage: diagCtx.lastStage
      };
      upsertFailures.push(failure);
      warnings.push(`upsert_timeout_or_error:${JSON.stringify(failure)}`);
      console.error(`${LOG} upsert threw`, failure);
      continue;
    }

    console.log(`${LOG} after upsert`, { callEventId: ev.id, status: res.status });

    if (res.status === "processed") {
      processedEvents++;
      if (res.createdCase) createdCases++;
      if (res.updatedCase) updatedCases++;
      createdDeliveries += res.createdDeliveries;
      warnings.push(...res.warnings);
      if (res.employeeNotFoundHit) {
        mergeEmployeeNotFoundHit(employeeNotFoundMap, res.employeeNotFoundHit);
      }
    } else if (res.status === "skipped" || res.status === "noop") {
      skippedEvents++;
      warnings.push(...res.warnings);
    } else {
      failedEvents++;
      if (res.error) warnings.push(`call_event_failed:${ev.id}:${res.error}`);
    }
  }

  const employeeNotFound = [...employeeNotFoundMap.values()].sort((a, b) => b.count - a.count);
  const issuesPresent =
    failedEvents > 0 || upsertFailures.length > 0 || employeeNotFound.length > 0;

  const summary: ProcessNewMissedCallEventsSummary = {
    scannedEvents: toProcess.length,
    processedEvents,
    skippedEvents,
    failedEvents,
    createdCases,
    updatedCases,
    createdDeliveries,
    warnings,
    employeeNotFound,
    upsertFailures,
    issuesPresent,
    fetchedCandidateEvents,
    alreadyProcessedCandidates,
    unprocessedCandidates,
    effectiveLimit
  };
  console.log(`${LOG} finish summary`, summary);
  return summary;
}
