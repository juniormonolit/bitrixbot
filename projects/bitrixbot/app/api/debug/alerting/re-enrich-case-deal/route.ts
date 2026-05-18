import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { reEnrichMissedCallCaseDeal } from "@/src/lib/bitrixbot/re-enrich-case-deal";

function isAuthorized(req: Request): boolean {
  const header = req.headers.get("x-debug-secret") ?? "";
  const url = new URL(req.url);
  const query = url.searchParams.get("secret") ?? "";
  const secret = header || query;
  return Boolean(secret && secret === env.DEBUG_SECRET);
}

/** Re-run deal enrichment for one missed_call_case from related call_events. */
export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const caseId = (url.searchParams.get("caseId") ?? "").trim();
  if (!caseId) {
    return NextResponse.json({ ok: false, error: "caseId required" }, { status: 400 });
  }

  const phoneEventLimitRaw = url.searchParams.get("phoneEventLimit");
  const phoneEventLimit = phoneEventLimitRaw
    ? Math.min(100, Math.max(10, parseInt(phoneEventLimitRaw, 10) || 50))
    : undefined;

  try {
    const supabase = createServiceRoleClient();
    const result = await reEnrichMissedCallCaseDeal(supabase, caseId, { phoneEventLimit });
    return NextResponse.json(result);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg, caseId }, { status: 500 });
  }
}
