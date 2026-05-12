import { createServiceRoleClient } from "@/lib/supabase/server";
import { upsertMissedCallCaseFromEvent } from "@/src/lib/bitrixbot/upsert-missed-call-case-from-event";

type CallEventRow = {
  id: string;
  occurred_at: string;
};

const DEFAULT_LIMIT = 100;
const MAX_EFFECTIVE_LIMIT = 500;
/** Upper bound on newest rows read from call_events (not full-table scan). */
const MAX_CANDIDATE_FETCH = 2000;

function clampEffectiveLimit(limit: number | undefined): number {
  const raw =
    typeof limit === "number" && Number.isFinite(limit) ? Math.floor(limit) : DEFAULT_LIMIT;
  if (raw < 1) return DEFAULT_LIMIT;
  return Math.min(MAX_EFFECTIVE_LIMIT, raw);
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
  /** Rows returned from the missed+inbound query (bounded batch). */
  fetchedCandidateEvents: number;
  /** Among fetched candidates, how many already have `call_event_case_processing`. */
  alreadyProcessedCandidates: number;
  /** Among fetched candidates, how many are not in processing yet (before applying work limit). */
  unprocessedCandidates: number;
  /** Limit after clamp [1, 500]; this many events are passed to `upsertMissedCallCaseFromEvent` at most. */
  effectiveLimit: number;
};

export async function processNewMissedCallEvents(
  limit: number = DEFAULT_LIMIT
): Promise<ProcessNewMissedCallEventsSummary> {
  const supabase = createServiceRoleClient();
  const warnings: string[] = [];

  const effectiveLimit = clampEffectiveLimit(limit);
  const candidateFetchSize = Math.min(
    MAX_CANDIDATE_FETCH,
    Math.max(effectiveLimit * 10, effectiveLimit)
  );

  const { data: candidates, error: candErr } = await supabase
    .from("call_events")
    .select("id, occurred_at")
    .eq("status", "missed")
    .eq("call_direction", "inbound")
    .order("occurred_at", { ascending: false })
    .limit(candidateFetchSize);

  if (candErr) throw new Error(candErr.message);

  const rows = (candidates ?? []) as CallEventRow[];
  const fetchedCandidateEvents = rows.length;

  if (rows.length === 0) {
    return {
      scannedEvents: 0,
      processedEvents: 0,
      skippedEvents: 0,
      failedEvents: 0,
      createdCases: 0,
      updatedCases: 0,
      createdDeliveries: 0,
      warnings,
      fetchedCandidateEvents: 0,
      alreadyProcessedCandidates: 0,
      unprocessedCandidates: 0,
      effectiveLimit
    };
  }

  const ids = rows.map((r) => r.id);
  const { data: processedRows, error: procErr } = await supabase
    .from("call_event_case_processing")
    .select("call_event_id")
    .in("call_event_id", ids);
  if (procErr) throw new Error(procErr.message);

  const already = new Set<string>(
    (processedRows ?? []).map((r) => (r as { call_event_id: string }).call_event_id)
  );

  const alreadyProcessedCandidates = rows.filter((r) => already.has(r.id)).length;
  const unprocessedOrdered = rows.filter((r) => !already.has(r.id));
  const unprocessedCandidates = unprocessedOrdered.length;
  const toProcess = unprocessedOrdered.slice(0, effectiveLimit);

  let processedEvents = 0;
  let skippedEvents = 0;
  let failedEvents = 0;
  let createdCases = 0;
  let updatedCases = 0;
  let createdDeliveries = 0;

  for (const ev of toProcess) {
    const res = await upsertMissedCallCaseFromEvent(ev.id);
    if (res.status === "processed") {
      processedEvents++;
      if (res.createdCase) createdCases++;
      if (res.updatedCase) updatedCases++;
      createdDeliveries += res.createdDeliveries;
      warnings.push(...res.warnings);
    } else if (res.status === "skipped" || res.status === "noop") {
      skippedEvents++;
      warnings.push(...res.warnings);
    } else {
      failedEvents++;
      if (res.error) warnings.push(`call_event_failed:${ev.id}:${res.error}`);
    }
  }

  return {
    scannedEvents: toProcess.length,
    processedEvents,
    skippedEvents,
    failedEvents,
    createdCases,
    updatedCases,
    createdDeliveries,
    warnings,
    fetchedCandidateEvents,
    alreadyProcessedCandidates,
    unprocessedCandidates,
    effectiveLimit
  };
}
