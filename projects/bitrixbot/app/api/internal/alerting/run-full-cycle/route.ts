import { NextResponse } from "next/server";
import { isAlertingDebugRequestAuthorized } from "@/src/lib/bitrixbot/debug-request-secret";
import { runAlertingFullCycle } from "@/src/lib/bitrixbot/run-alerting-full-cycle";

export async function POST(req: Request) {
  if (!isAlertingDebugRequestAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as null | { limit?: number };
  const limit = body?.limit ?? 100;

  const startedAt = Date.now();
  const summary = await runAlertingFullCycle(limit);
  const durationMs = Date.now() - startedAt;

  let issuesPresent = false;
  const mc = summary.missedCalls;
  if (mc) {
    if (!mc.ok) issuesPresent = true;
    else if (
      mc.result.failedEvents > 0 ||
      mc.result.upsertFailures.length > 0 ||
      mc.result.issuesPresent
    ) {
      issuesPresent = true;
    }
  }

  return NextResponse.json({
    ok: true,
    durationMs,
    summary,
    issuesPresent
  });
}
