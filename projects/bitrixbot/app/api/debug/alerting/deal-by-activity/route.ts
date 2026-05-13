import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { resolveDealByCrmActivityId } from "@/src/lib/bitrixbot/deal-enrichment-from-activity";

function isAuthorized(req: Request): boolean {
  const header = req.headers.get("x-debug-secret") ?? "";
  const url = new URL(req.url);
  const query = url.searchParams.get("secret") ?? "";
  const secret = header || query;
  return Boolean(secret && secret === env.DEBUG_SECRET);
}

/** Resolve CRM activity → deal (diagnostics; same logic as missed-call enrichment). */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const activityId = (url.searchParams.get("activityId") ?? "").trim();
  if (!activityId) {
    return NextResponse.json({ ok: false, error: "activityId required" }, { status: 400 });
  }

  try {
    const resolution = await resolveDealByCrmActivityId(activityId);
    return NextResponse.json({
      ok: true,
      activityId,
      activity: resolution.activity ?? {},
      bindings: resolution.bindings,
      deal: resolution.deal,
      reason: resolution.reason
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg, activityId }, { status: 502 });
  }
}
