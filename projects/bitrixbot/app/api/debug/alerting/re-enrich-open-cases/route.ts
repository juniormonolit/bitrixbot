import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { openCaseNeedsDealBackfill, reEnrichMissedCallCaseDeal } from "@/src/lib/bitrixbot/re-enrich-case-deal";

function isAuthorized(req: Request): boolean {
  const header = req.headers.get("x-debug-secret") ?? "";
  const url = new URL(req.url);
  const query = url.searchParams.get("secret") ?? "";
  const secret = header || query;
  return Boolean(secret && secret === env.DEBUG_SECRET);
}

/** Batch re-enrich open missed_call_cases with missing or invalid deal fields. */
export async function POST(request: Request) {
  void request;
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "50", 10) || 50));

  const supabase = createServiceRoleClient();
  const { data: rows, error } = await supabase
    .from("missed_call_cases")
    .select("id, deal_id, deal_url, deal_enriched_at, phone_normalized")
    .eq("status", "open")
    .order("last_missed_at", { ascending: false })
    .limit(limit * 4);

  if (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }

  const candidates = (rows ?? []).filter((r) =>
    openCaseNeedsDealBackfill(r as { deal_id: number | null; deal_url: string | null; deal_enriched_at: string | null })
  );
  const targets = candidates.slice(0, limit) as { id: string }[];
  const scannedCases = targets.length;
  let updatedCases = 0;
  let noDealFound = 0;
  const errors: string[] = [];
  const examples: { caseId: string; chosenDealId: string | null; errors: string[] }[] = [];

  for (const t of targets) {
    try {
      const res = await reEnrichMissedCallCaseDeal(supabase, t.id, { phoneEventLimit: 50 });
      if (res.chosenDeal) updatedCases++;
      else noDealFound++;
      if (res.errors.length) errors.push(...res.errors.map((e) => `${t.id}:${e}`));
      if (examples.length < 8) {
        examples.push({
          caseId: t.id,
          chosenDealId: res.chosenDeal?.dealId ?? null,
          errors: res.errors
        });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      errors.push(`${t.id}:${msg}`);
    }
  }

  return NextResponse.json({
    ok: true,
    limit,
    scannedCases,
    updatedCases,
    noDealFound,
    errors,
    examples
  });
}
