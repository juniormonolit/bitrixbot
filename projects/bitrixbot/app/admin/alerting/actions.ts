"use server";

import { revalidatePath } from "next/cache";
import { rebuildOrgResolvedHierarchy } from "@/src/lib/bitrixbot/resolve-org-hierarchy";
import { processNewMissedCallEvents } from "@/src/lib/bitrixbot/process-new-missed-call-events";
import { processOpenCasesForCallbackResolution } from "@/src/lib/bitrixbot/process-open-cases-for-callback-resolution";
import { processNoCallbackEscalations } from "@/src/lib/bitrixbot/process-no-callback-escalations";
import { processPendingDeliveries } from "@/src/lib/bitrixbot/process-pending-deliveries";
import { runAlertingFullCycle, type AlertingFullCycleSummary } from "@/src/lib/bitrixbot/run-alerting-full-cycle";

export type ManualAction =
  | "rebuild_hierarchy"
  | "process_missed_calls"
  | "process_callback_resolution"
  | "process_no_callback_escalations"
  | "process_pending_deliveries"
  | "run_full_cycle";

export type ManualActionState = {
  ok: boolean;
  action: ManualAction | null;
  limit: number | null;
  startedAt: string | null;
  durationMs: number | null;
  result: unknown;
  error: string | null;
};

export async function runManualAction(
  _prev: ManualActionState,
  formData: FormData
): Promise<ManualActionState> {
  const action = String(formData.get("action") ?? "") as ManualAction;
  const limit = Number(formData.get("limit") ?? 100) || 100;

  const startedAt = new Date();
  const t0 = Date.now();

  try {
    let result: unknown;

    if (action === "rebuild_hierarchy") {
      result = await rebuildOrgResolvedHierarchy();
    } else if (action === "process_missed_calls") {
      result = await processNewMissedCallEvents(limit);
    } else if (action === "process_callback_resolution") {
      result = await processOpenCasesForCallbackResolution(limit);
    } else if (action === "process_no_callback_escalations") {
      result = await processNoCallbackEscalations(limit);
    } else if (action === "process_pending_deliveries") {
      result = await processPendingDeliveries(limit);
    } else if (action === "run_full_cycle") {
      result = await runAlertingFullCycle(limit);
    } else {
      throw new Error("unknown_action");
    }

    revalidatePath("/admin/alerting");

    let ok = true;
    if (action === "run_full_cycle") {
      const s = result as AlertingFullCycleSummary;
      ok =
        s.hierarchy.ok &&
        (s.missedCalls == null || s.missedCalls.ok) &&
        (s.callbackResolution == null || s.callbackResolution.ok) &&
        (s.noCallbackEscalations == null || s.noCallbackEscalations.ok) &&
        (s.pendingDeliveries == null || s.pendingDeliveries.ok);
    }

    return {
      ok,
      action,
      limit,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - t0,
      result,
      error: null
    };
  } catch (e) {
    return {
      ok: false,
      action,
      limit,
      startedAt: startedAt.toISOString(),
      durationMs: Date.now() - t0,
      result: null,
      error: e instanceof Error ? e.message : String(e)
    };
  }
}

