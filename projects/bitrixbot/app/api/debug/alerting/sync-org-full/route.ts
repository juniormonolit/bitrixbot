import { NextResponse } from "next/server";
import { isAlertingDebugRequestAuthorized } from "@/src/lib/bitrixbot/debug-request-secret";
import {
  syncOrgStructureFromBitrixAndRebuildWithLogs,
  type SyncOrgFullProgress
} from "@/src/lib/bitrixbot/sync-org-structure-from-bitrix";

const LOG = "[sync-org-full]";
const SYNC_ORG_FULL_TIMEOUT_MS = 120_000;

/** Vercel / Node route max duration (seconds). */
export const maxDuration = 120;

export async function POST(req: Request) {
  if (!isAlertingDebugRequestAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const progress: SyncOrgFullProgress = { lastStage: "init" };

  let forceManagersRefresh = false;
  try {
    const body = (await req.json()) as { forceManagersRefresh?: boolean };
    forceManagersRefresh = body?.forceManagersRefresh === true;
  } catch {
    /* empty body */
  }

  console.log(`${LOG} start forceManagersRefresh=${forceManagersRefresh}`);

  try {
    const outcome = await Promise.race([
      syncOrgStructureFromBitrixAndRebuildWithLogs(progress, { forceManagersRefresh }).then((result) => ({
        type: "done" as const,
        result
      })),
      new Promise<{ type: "timeout" }>((resolve) => {
        setTimeout(() => resolve({ type: "timeout" }), SYNC_ORG_FULL_TIMEOUT_MS);
      })
    ]);

    if (outcome.type === "timeout") {
      console.error(`${LOG} error stage=${progress.lastStage} message=sync_org_full_timeout`);
      return NextResponse.json(
        {
          ok: false,
          error: "sync_org_full_timeout",
          timeoutMs: SYNC_ORG_FULL_TIMEOUT_MS,
          lastStage: progress.lastStage,
          progress: progress.partial ?? {}
        },
        { status: 504 }
      );
    }

    const durationMs = Date.now() - startedAt;
    console.log(`${LOG} done durationMs=${durationMs}`);
    return NextResponse.json({
      ok: true,
      durationMs,
      result: outcome.result
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${LOG} error stage=${progress.lastStage} message=${msg}`);
    return NextResponse.json(
      {
        ok: false,
        error: msg,
        lastStage: progress.lastStage,
        progress: progress.partial ?? {},
        durationMs: Date.now() - startedAt
      },
      { status: 500 }
    );
  }
}
