import { NextResponse } from "next/server";
import { isAlertingDebugRequestAuthorized } from "@/lib/bitrixbot/debug-request-secret";
import { tryAcquireAlertingCycleLease, releaseAlertingCycleLease } from "@/lib/bitrixbot/alerting-cycle-lease";
import { processNewMissedCallEvents } from "@/lib/bitrixbot/process-new-missed-call-events";
import { processPendingDeliveries } from "@/lib/bitrixbot/process-pending-deliveries";

const ROUTE_LOG = "[internal:run-alerting-cycle]";

/**
 * Production cron entrypoint: missed calls → enqueue deliveries, then send pending.
 * Single-flight DB lock; same auth as other internal alerting routes (`x-debug-secret` / `DEBUG_SECRET`).
 */
export async function POST(req: Request) {
  if (!isAlertingDebugRequestAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as null | { limit?: number; leaseSeconds?: number };
  const limit = typeof body?.limit === "number" && Number.isFinite(body.limit) ? Math.floor(body.limit) : 100;
  const leaseSeconds =
    typeof body?.leaseSeconds === "number" && Number.isFinite(body.leaseSeconds)
      ? Math.floor(body.leaseSeconds)
      : 900;

  const startedAt = Date.now();
  const acquired = await tryAcquireAlertingCycleLease(leaseSeconds);
  if (!acquired) {
    console.warn(`${ROUTE_LOG} lock busy`);
    return NextResponse.json(
      { ok: false, error: "lock_held", message: "Another alerting cycle run is in progress" },
      { status: 409 }
    );
  }

  try {
    const missedSummary = await processNewMissedCallEvents(limit);
    const pendingSummary = await processPendingDeliveries(limit);
    const durationMs = Date.now() - startedAt;
    console.log(`${ROUTE_LOG} ok`, { durationMs, createdDeliveries: missedSummary.createdDeliveries });

    const issuesPresent = Boolean(
      missedSummary.issuesPresent ||
        (typeof missedSummary.failedEvents === "number" && missedSummary.failedEvents > 0)
    );

    return NextResponse.json({
      ok: true,
      durationMs,
      missedSummary,
      pendingSummary,
      issuesPresent
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${ROUTE_LOG} error`, msg);
    return NextResponse.json(
      { ok: false, error: msg, durationMs: Date.now() - startedAt },
      { status: 500 }
    );
  } finally {
    await releaseAlertingCycleLease();
  }
}
