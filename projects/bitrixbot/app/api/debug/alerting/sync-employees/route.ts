import { NextResponse } from "next/server";
import { syncEmployees } from "@/lib/bitrix/org";
import { isAlertingDebugRequestAuthorized } from "@/lib/bitrixbot/debug-request-secret";

const LOG = "[sync-org-debug] sync-employees";
const TIMEOUT_MS = 120_000;

export async function POST(req: Request) {
  if (!isAlertingDebugRequestAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  console.log(`${LOG} start`);

  try {
    const outcome = await Promise.race([
      syncEmployees().then((result) => ({ type: "done" as const, result })),
      new Promise<{ type: "timeout" }>((resolve) => setTimeout(() => resolve({ type: "timeout" }), TIMEOUT_MS))
    ]);

    if (outcome.type === "timeout") {
      console.error(`${LOG} error message=timeout`);
      return NextResponse.json(
        { ok: false, error: "sync_employees_timeout", timeoutMs: TIMEOUT_MS, lastStage: "sync_employees" },
        { status: 504 }
      );
    }

    const durationMs = Date.now() - startedAt;
    console.log(`${LOG} done durationMs=${durationMs}`);
    return NextResponse.json({ ok: true, durationMs, result: outcome.result });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${LOG} error message=${msg}`);
    return NextResponse.json(
      { ok: false, error: msg, durationMs: Date.now() - startedAt },
      { status: 500 }
    );
  }
}
