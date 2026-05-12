import { createServiceRoleClient } from "@/lib/supabase/server";
import { resolveMissedCallCaseByCallback } from "@/src/lib/bitrixbot/resolve-missed-call-case-by-callback";

export type CallbackResolutionSummary = {
  scannedCases: number;
  resolvedCases: number;
  skippedCases: number;
  warnings: string[];
};

export async function processOpenCasesForCallbackResolution(
  limit: number = 100
): Promise<CallbackResolutionSummary> {
  const supabase = createServiceRoleClient();
  const warnings: string[] = [];

  const { data: cases, error } = await supabase
    .from("missed_call_cases")
    .select("id")
    .eq("status", "open")
    .order("last_missed_at", { ascending: true })
    .limit(limit);
  if (error) throw new Error(error.message);

  const ids = (cases ?? []).map((c) => (c as { id: string }).id);

  let resolvedCases = 0;
  let skippedCases = 0;

  for (const id of ids) {
    const res = await resolveMissedCallCaseByCallback(id);
    warnings.push(...res.warnings.map((w) => `${id}:${w}`));
    if (res.status === "resolved") resolvedCases++;
    else skippedCases++;
  }

  return {
    scannedCases: ids.length,
    resolvedCases,
    skippedCases,
    warnings
  };
}

