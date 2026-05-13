import { NextResponse } from "next/server";
import { isAlertingDebugRequestAuthorized } from "@/src/lib/bitrixbot/debug-request-secret";
import { syncOrgStructureFromBitrixAndRebuild } from "@/src/lib/bitrixbot/sync-org-structure-from-bitrix";

export async function POST(req: Request) {
  if (!isAlertingDebugRequestAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  try {
    const result = await syncOrgStructureFromBitrixAndRebuild();
    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      result
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg, durationMs: Date.now() - startedAt },
      { status: 500 }
    );
  }
}
