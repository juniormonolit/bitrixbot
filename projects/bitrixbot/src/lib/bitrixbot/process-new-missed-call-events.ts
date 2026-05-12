import { createServiceRoleClient } from "@/lib/supabase/server";
import { upsertMissedCallCaseFromEvent } from "@/src/lib/bitrixbot/upsert-missed-call-case-from-event";

type CallEventRow = {
  id: string;
  occurred_at: string;
};

export type ProcessNewMissedCallEventsSummary = {
  scannedEvents: number;
  processedEvents: number;
  skippedEvents: number;
  failedEvents: number;
  createdCases: number;
  updatedCases: number;
  createdDeliveries: number;
  warnings: string[];
};

export async function processNewMissedCallEvents(
  limit: number = 100
): Promise<ProcessNewMissedCallEventsSummary> {
  const supabase = createServiceRoleClient();
  const warnings: string[] = [];

  const { data: candidates, error: candErr } = await supabase
    .from("call_events")
    .select("id, occurred_at")
    .order("occurred_at", { ascending: true })
    .limit(limit * 2);
  if (candErr) throw new Error(candErr.message);

  const rows = (candidates ?? []) as CallEventRow[];
  if (rows.length === 0) {
    return {
      scannedEvents: 0,
      processedEvents: 0,
      skippedEvents: 0,
      failedEvents: 0,
      createdCases: 0,
      updatedCases: 0,
      createdDeliveries: 0,
      warnings
    };
  }

  const ids = rows.map((r) => r.id);
  const { data: processedRows, error: procErr } = await supabase
    .from("call_event_case_processing")
    .select("call_event_id")
    .in("call_event_id", ids);
  if (procErr) throw new Error(procErr.message);

  const already = new Set<string>((processedRows ?? []).map((r) => (r as { call_event_id: string }).call_event_id));
  const toProcess = rows.filter((r) => !already.has(r.id)).slice(0, limit);

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
    warnings
  };
}

