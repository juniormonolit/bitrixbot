import { rebuildOrgResolvedHierarchy, type RebuildHierarchyResult } from "@/src/lib/bitrixbot/resolve-org-hierarchy";
import {
  processNewMissedCallEvents,
  type ProcessNewMissedCallEventsSummary
} from "@/src/lib/bitrixbot/process-new-missed-call-events";
import {
  processOpenCasesForCallbackResolution,
  type CallbackResolutionSummary
} from "@/src/lib/bitrixbot/process-open-cases-for-callback-resolution";
import {
  processNoCallbackEscalations,
  type NoCallbackEscalationsSummary
} from "@/src/lib/bitrixbot/process-no-callback-escalations";
import {
  processPendingDeliveries,
  type ProcessPendingDeliveriesSummary
} from "@/src/lib/bitrixbot/process-pending-deliveries";

export type AlertingFullCycleStageOk<T> = { ok: true; durationMs: number; result: T };
export type AlertingFullCycleStageErr = { ok: false; durationMs: number; error: string };
export type AlertingFullCycleStage<T> = AlertingFullCycleStageOk<T> | AlertingFullCycleStageErr;

export type AlertingFullCycleSummary = {
  hierarchy: AlertingFullCycleStage<RebuildHierarchyResult>;
  missedCalls: AlertingFullCycleStage<ProcessNewMissedCallEventsSummary> | null;
  callbackResolution: AlertingFullCycleStage<CallbackResolutionSummary> | null;
  noCallbackEscalations: AlertingFullCycleStage<NoCallbackEscalationsSummary> | null;
  pendingDeliveries: AlertingFullCycleStage<ProcessPendingDeliveriesSummary> | null;
};

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export async function runAlertingFullCycle(limit: number = 100): Promise<AlertingFullCycleSummary> {
  const emptyTail = (): Omit<AlertingFullCycleSummary, "hierarchy"> => ({
    missedCalls: null,
    callbackResolution: null,
    noCallbackEscalations: null,
    pendingDeliveries: null
  });

  const h0 = Date.now();
  let hierarchy: AlertingFullCycleStage<RebuildHierarchyResult>;
  try {
    const result = await rebuildOrgResolvedHierarchy();
    hierarchy = { ok: true, durationMs: Date.now() - h0, result };
  } catch (e) {
    hierarchy = { ok: false, durationMs: Date.now() - h0, error: errMessage(e) };
    return { hierarchy, ...emptyTail() };
  }

  const m0 = Date.now();
  let missedCalls: AlertingFullCycleStage<ProcessNewMissedCallEventsSummary>;
  try {
    const result = await processNewMissedCallEvents(limit);
    missedCalls = { ok: true, durationMs: Date.now() - m0, result };
  } catch (e) {
    missedCalls = { ok: false, durationMs: Date.now() - m0, error: errMessage(e) };
    return {
      hierarchy,
      missedCalls,
      callbackResolution: null,
      noCallbackEscalations: null,
      pendingDeliveries: null
    };
  }

  const c0 = Date.now();
  let callbackResolution: AlertingFullCycleStage<CallbackResolutionSummary>;
  try {
    const result = await processOpenCasesForCallbackResolution(limit);
    callbackResolution = { ok: true, durationMs: Date.now() - c0, result };
  } catch (e) {
    callbackResolution = { ok: false, durationMs: Date.now() - c0, error: errMessage(e) };
  }

  const n0 = Date.now();
  let noCallbackEscalations: AlertingFullCycleStage<NoCallbackEscalationsSummary>;
  try {
    const result = await processNoCallbackEscalations(limit);
    noCallbackEscalations = { ok: true, durationMs: Date.now() - n0, result };
  } catch (e) {
    noCallbackEscalations = { ok: false, durationMs: Date.now() - n0, error: errMessage(e) };
  }

  const p0 = Date.now();
  let pendingDeliveries: AlertingFullCycleStage<ProcessPendingDeliveriesSummary>;
  try {
    const result = await processPendingDeliveries(limit);
    pendingDeliveries = { ok: true, durationMs: Date.now() - p0, result };
  } catch (e) {
    pendingDeliveries = { ok: false, durationMs: Date.now() - p0, error: errMessage(e) };
  }

  return {
    hierarchy,
    missedCalls,
    callbackResolution,
    noCallbackEscalations,
    pendingDeliveries
  };
}
