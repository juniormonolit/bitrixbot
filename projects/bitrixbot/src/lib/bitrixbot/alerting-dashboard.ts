import { createServiceRoleClient } from "@/lib/supabase/server";

export type AlertingDashboardSummary = {
  openCases: number;
  pendingDeliveries: number;
  skippedPrimaryDeliveries: number;
  sentDeliveries24h: number;
  failedDeliveries: number;
  pendingMirrors: number;
  failedMirrors: number;
  failedCallEventProcessing: number;
  openSlaExecutions: number;
  lastOrgResolvedAt: string | null;
};

export async function getAlertingDashboardSummary(): Promise<AlertingDashboardSummary> {
  const supabase = createServiceRoleClient();

  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  const [
    { count: openCases, error: openErr },
    { count: pendingDeliveries, error: delPendErr },
    { count: skippedPrimaryDeliveries, error: delSkippedErr },
    { count: sentDeliveries24h, error: delSentErr },
    { count: failedDeliveries, error: delFailErr },
    { count: pendingMirrors, error: mirPendErr },
    { count: failedMirrors, error: mirFailErr },
    { count: failedCallEventProcessing, error: failErr }
  ] = await Promise.all([
    supabase.from("missed_call_cases").select("id", { count: "exact", head: true }).eq("status", "open"),
    supabase.from("notification_deliveries").select("id", { count: "exact", head: true }).eq("delivery_status", "pending"),
    supabase.from("notification_deliveries").select("id", { count: "exact", head: true }).eq("delivery_status", "skipped"),
    supabase.from("notification_deliveries").select("id", { count: "exact", head: true }).eq("delivery_status", "sent").gte("sent_at", since24h),
    supabase.from("notification_deliveries").select("id", { count: "exact", head: true }).eq("delivery_status", "failed"),
    supabase.from("notification_delivery_mirrors").select("id", { count: "exact", head: true }).eq("delivery_status", "pending"),
    supabase.from("notification_delivery_mirrors").select("id", { count: "exact", head: true }).eq("delivery_status", "failed"),
    supabase.from("call_event_case_processing").select("id", { count: "exact", head: true }).eq("processing_status", "failed")
  ]);
  if (openErr) throw new Error(openErr.message);
  if (delPendErr) throw new Error(delPendErr.message);
  if (delSkippedErr) throw new Error(delSkippedErr.message);
  if (delSentErr) throw new Error(delSentErr.message);
  if (delFailErr) throw new Error(delFailErr.message);
  if (mirPendErr) throw new Error(mirPendErr.message);
  if (mirFailErr) throw new Error(mirFailErr.message);
  if (failErr) throw new Error(failErr.message);

  const { count: slaCount, error: slaErr } = await supabase
    .from("case_rule_executions")
    .select("id", { count: "exact", head: true })
    .in("execution_status", ["pending", "executed"]);
  if (slaErr) throw new Error(slaErr.message);

  const { data: lastResolved, error: lastErr } = await supabase
    .from("org_resolved_hierarchy")
    .select("resolved_at")
    .order("resolved_at", { ascending: false })
    .limit(1);
  if (lastErr) throw new Error(lastErr.message);

  const lastOrgResolvedAt =
    (lastResolved?.[0] as { resolved_at?: string } | undefined)?.resolved_at ?? null;

  return {
    openCases: openCases ?? 0,
    pendingDeliveries: pendingDeliveries ?? 0,
    skippedPrimaryDeliveries: skippedPrimaryDeliveries ?? 0,
    sentDeliveries24h: sentDeliveries24h ?? 0,
    failedDeliveries: failedDeliveries ?? 0,
    pendingMirrors: pendingMirrors ?? 0,
    failedMirrors: failedMirrors ?? 0,
    failedCallEventProcessing: failedCallEventProcessing ?? 0,
    openSlaExecutions: slaCount ?? 0,
    lastOrgResolvedAt
  };
}

