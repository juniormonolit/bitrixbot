import { createServiceRoleClient } from "@/lib/supabase/server";
import { normalizeBitrixUserId } from "@/src/lib/bitrixbot/bitrix-user-id";
import { withTimeout } from "@/src/lib/bitrixbot/async-timeout";
import { prepareNotificationsForMissedCallCase } from "@/src/lib/bitrixbot/prepare-notifications-for-missed-call-case";
import {
  upsertMissedCallCaseFromEvent,
  type DealEnrichmentCallSnapshot,
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
const PREPARE_NOTIFICATIONS_TIMEOUT_MS = 4_500;
export type EmployeeNotFoundAgg = {
  managerBitrixUserId: string | null;
  count: number;
  sampleCallEventIds: string[];
  samplePhones: string[];
  /** Primary delivery создан напрямую на manager_bitrix_user_id (fallback). */
  deliveryFallbackUsed: boolean;
};

export type UpsertFailureDiag = {
  callEventId: string;
  phone: string | null;
  managerBitrixUserId: string | null;
  occurredAt: string | null;
  message: string;
  lastKnownStage: string;
  /** true если сработал внешний timeout (событие помечено retryable_error). */
  retryScheduled?: boolean;
};

export type DealEnrichmentSummary = {
  /** События, где после enrich есть bitrix_deal_id. */
  found: number;
  /** Нормальный исход: сделку не удалось сопоставить. */
  notFound: number;
  /** Сделка найдена по CRM activity. */
  byActivity: number;
  /** Сделка найдена по телефону. */
  byPhone: number;
  /** Исключения / сбой Bitrix / persist. */
  errors: number;
};

function bumpDealEnrichmentSummary(agg: DealEnrichmentSummary, snap: DealEnrichmentCallSnapshot) {
  const err = snap.enrichmentError ?? "";
  if (err.startsWith("enrichment_exception") || err.includes("activity_fetch_failed")) {
    agg.errors++;
    return;
  }
  if (snap.hasDealId) {
    agg.found++;
    if (snap.source === "crm_activity") agg.byActivity++;
    else if (snap.source === "phone_lookup") agg.byPhone++;
    return;
  }
  agg.notFound++;
}

async function markProcessingRetryableByCallEventId(
  supabase: ReturnType<typeof createServiceRoleClient>,
  callEventId: string,
  message: string
) {
  const { data, error } = await supabase
    .from("call_event_case_processing")
    .select("id, processing_attempts")
    .eq("call_event_id", callEventId)
    .maybeSingle();
  if (error || !data) return;
  const attempts = ((data as { processing_attempts?: number }).processing_attempts ?? 0) + 1;
  const { error: updErr } = await supabase
    .from("call_event_case_processing")
    .update({
      processing_status: "retryable_error",
      error_message: message.slice(0, 2000),
      processed_at: null,
      processing_attempts: attempts
    })
    .eq("id", (data as { id: string }).id);
  if (updErr) console.error(`${LOG} mark_retryable_failed`, { callEventId, message: updErr.message });
}

function clampEffectiveLimit(limit: number | undefined): number {
  const raw =
    typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIMIT;
  if (raw < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_EFFECTIVE_LIMIT, raw);
}

/** Агрегат для summary: детальные причины filter skip (ключи без префикса skip_). */
function bucketSkipReason(reason: string): string {
  switch (reason) {
    case "skip_outgoing_call":
      return "outgoing_call";
    case "skip_unknown_call_type":
    case "skip_call_type_3":
      return "unknown_call_type";
    case "skip_not_inbound":
      return "not_inbound";
    case "skip_call_event_not_final":
      return "not_final_event";
    case "skip_not_missed":
    case "skip_not_missed_status":
    case "skip_not_missed_positive_duration_column":
    case "skip_not_missed_answered_or_completed_payload":
    case "skip_not_missed_strict_payload":
      return "not_missed";
    case "skip_missing_phone":
    case "skip_phone_same_as_portal":
    case "skip_phone_internal_like":
      return "missing_or_invalid_phone";
    case "skip_missing_manager":
    case "skip_missing_manager_portal_user":
      return "missing_manager";
    default:
      return reason.replace(/^skip_/, "");
  }
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

function mergeEmployeeNotFoundHit(
  map: Map<string, EmployeeNotFoundAgg>,
  hit: NonNullable<UpsertMissedCallCaseResult["employeeNotFoundHit"]>,
  deliveryFallbackUsed: boolean
) {
  const norm = normalizeBitrixUserId(hit.managerBitrixUserId);
  const mapKey = norm ?? "__null__";
  const cur =
    map.get(mapKey) ??
    ({
      managerBitrixUserId: norm,
      count: 0,
      sampleCallEventIds: [],
      samplePhones: [],
      deliveryFallbackUsed: false
    } as EmployeeNotFoundAgg);
  cur.count++;
  if (deliveryFallbackUsed) cur.deliveryFallbackUsed = true;
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
  /** Ошибки upsert (в т.ч. опциональный внешний timeout, см. MISSED_CALL_UPSERT_TIMEOUT_MS). */
  upsertFailures: UpsertFailureDiag[];
  /** События, помеченные retryable_error после timeout (не failedEvents). */
  recoverableUpsertErrors: number;
  /** Агрегат обогащения сделки по обработанным событиям (не warning). */
  dealEnrichment: DealEnrichmentSummary;
  /** Есть ли что показать как warning в UI (таймауты, failedEvents, missing employees). */
  issuesPresent: boolean;
  /** Rows returned from the missed-call candidate query (bounded batch). */
  fetchedCandidateEvents: number;
  /** Кандидаты с терминальным processing (processed / skipped / failed). */
  alreadyProcessedCandidates: number;
  /** Кандидаты без терминального processing (включая pending / retryable_error). */
  unprocessedCandidates: number;
  /** Limit after clamp [1, 100]; this many events are passed to `upsertMissedCallCaseFromEvent` at most. */
  effectiveLimit: number;
  /** Сколько событий отфильтровано helper’ом по причине (см. bucketSkipReason). */
  skippedReasons: Record<string, number>;
};

const emptyDealEnrichment = (): DealEnrichmentSummary => ({
  found: 0,
  notFound: 0,
  byActivity: 0,
  byPhone: 0,
  errors: 0
});

function parseUpsertTimeoutMs(): number | null {
  const raw = process.env.MISSED_CALL_UPSERT_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === "") return null;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.max(1000, Math.floor(n));
}

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
    .in("status", ["missed", "other"])
    .eq("call_type_raw", "2")
    .neq("call_direction", "outbound")
    .or("call_duration_seconds.is.null,call_duration_seconds.eq.0")
    .order("occurred_at", { ascending: false })
    .limit(candidateFetchSize);

  if (candErr) {
    console.error(`${LOG} candidate call_events error`, candErr);
    formatSupabaseError("call_events.select(inbound_type2_non_outbound_duration0_missed_or_other)", candErr);
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
      recoverableUpsertErrors: 0,
      dealEnrichment: emptyDealEnrichment(),
      issuesPresent: false,
      fetchedCandidateEvents: 0,
      alreadyProcessedCandidates: 0,
      unprocessedCandidates: 0,
      effectiveLimit,
      skippedReasons: {}
    };
    console.log(`${LOG} finish summary (no candidates)`, emptySummary);
    return emptySummary;
  }

  const ids = rows.map((r) => r.id);
  console.log(`${LOG} before processing rows query`, { idCount: ids.length });
  const { data: processingRows, error: procErr } = await supabase
    .from("call_event_case_processing")
    .select("call_event_id, processing_status")
    .in("call_event_id", ids);
  if (procErr) {
    console.error(`${LOG} processing rows error`, procErr);
    formatSupabaseError("call_event_case_processing.select", procErr);
  }
  console.log(`${LOG} after processing rows`, {
    count: (processingRows ?? []).length,
    error: null
  });

  const terminalStatuses = new Set(["processed", "skipped", "failed"]);
  const terminalByCallEvent = new Set(
    (processingRows ?? [])
      .filter((r) => terminalStatuses.has((r as { processing_status: string }).processing_status))
      .map((r) => (r as { call_event_id: string }).call_event_id)
  );

  const alreadyProcessedCandidates = rows.filter((r) => terminalByCallEvent.has(r.id)).length;
  const unprocessedOrdered = rows.filter((r) => !terminalByCallEvent.has(r.id));
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
  const skippedReasons: Record<string, number> = {};
  const dealEnrichment = emptyDealEnrichment();
  let recoverableUpsertErrors = 0;

  const upsertTimeoutMs = parseUpsertTimeoutMs();

  for (const ev of toProcess) {
    console.log(`${LOG} before upsert`, {
      callEventId: ev.id,
      occurred_at: ev.occurred_at,
      phone_normalized: ev.phone_normalized,
      manager_bitrix_user_id: ev.manager_bitrix_user_id,
      upsertTimeoutMs: upsertTimeoutMs ?? "off",
      prepareNotificationsTimeoutMs: PREPARE_NOTIFICATIONS_TIMEOUT_MS
    });

    const diagCtx = { lastStage: "queued" };
    let res: Awaited<ReturnType<typeof upsertMissedCallCaseFromEvent>>;
    try {
      res =
        upsertTimeoutMs != null
          ? await withTimeout(
              upsertMissedCallCaseFromEvent(ev.id, diagCtx),
              upsertTimeoutMs,
              `upsert:${ev.id}`
            )
          : await upsertMissedCallCaseFromEvent(ev.id, diagCtx);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const isTimeout = /timeout after \d+ms/i.test(msg);
      const failure: UpsertFailureDiag = {
        callEventId: ev.id,
        phone: ev.phone_normalized,
        managerBitrixUserId: ev.manager_bitrix_user_id,
        occurredAt: ev.occurred_at,
        message: msg,
        lastKnownStage: diagCtx.lastStage,
        retryScheduled: isTimeout
      };
      upsertFailures.push(failure);
      if (isTimeout) {
        recoverableUpsertErrors++;
        await markProcessingRetryableByCallEventId(supabase, ev.id, msg);
        warnings.push(`upsert_timeout_retryable:${JSON.stringify(failure)}`);
        console.error(`${LOG} upsert timeout (retryable)`, failure);
      } else {
        failedEvents++;
        warnings.push(`upsert_error:${JSON.stringify(failure)}`);
        console.error(`${LOG} upsert threw`, failure);
      }
      continue;
    }

    console.log(`${LOG} after upsert`, { callEventId: ev.id, status: res.status });

    if (res.status === "processed") {
      processedEvents++;
      if (res.createdCase) createdCases++;
      if (res.updatedCase) updatedCases++;
      warnings.push(...res.warnings);

      if (res.dealEnrichment) bumpDealEnrichmentSummary(dealEnrichment, res.dealEnrichment);

      let deliveryFallbackUsed = false;
      if (res.caseId) {
        const prepDiag = { lastStage: "prepare_notifications_start" };
        try {
          const prep = await withTimeout(
            prepareNotificationsForMissedCallCase(res.caseId, prepDiag, {
              treatManagerAsEmployeeFallback: Boolean(res.employeeNotFoundHit)
            }),
            PREPARE_NOTIFICATIONS_TIMEOUT_MS,
            `prepare_notifications:${ev.id}`
          );
          createdDeliveries += prep.createdDeliveriesCount;
          warnings.push(...prep.warnings);
          deliveryFallbackUsed = prep.managerRecipientFallbackUsed;
        } catch (prepErr) {
          const pmsg = prepErr instanceof Error ? prepErr.message : String(prepErr);
          warnings.push(
            `prepare_notifications_failed:${pmsg} lastStage=${prepDiag.lastStage} caseId=${res.caseId}`
          );
          console.error(`${LOG} prepare_notifications error`, {
            callEventId: ev.id,
            caseId: res.caseId,
            lastStage: prepDiag.lastStage,
            message: pmsg
          });
        }
      }

      if (res.employeeNotFoundHit) {
        mergeEmployeeNotFoundHit(employeeNotFoundMap, res.employeeNotFoundHit, deliveryFallbackUsed);
      }
    } else if (res.status === "skipped") {
      skippedEvents++;
      if (res.filterSkipReason) {
        const b = bucketSkipReason(res.filterSkipReason);
        skippedReasons[b] = (skippedReasons[b] ?? 0) + 1;
      }
      warnings.push(...res.warnings);
    } else if (res.status === "noop") {
      warnings.push(...res.warnings);
    } else {
      failedEvents++;
      if (res.error) warnings.push(`call_event_failed:${ev.id}:${res.error}`);
    }
  }

  const employeeNotFound = [...employeeNotFoundMap.values()].sort((a, b) => b.count - a.count);
  const issuesPresent =
    failedEvents > 0 ||
    recoverableUpsertErrors > 0 ||
    upsertFailures.some((f) => f.retryScheduled !== true) ||
    employeeNotFound.length > 0 ||
    dealEnrichment.errors > 0;

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
    recoverableUpsertErrors,
    dealEnrichment,
    issuesPresent,
    fetchedCandidateEvents,
    alreadyProcessedCandidates,
    unprocessedCandidates,
    effectiveLimit,
    skippedReasons
  };
  console.log(`${LOG} finish summary`, summary);
  return summary;
}
