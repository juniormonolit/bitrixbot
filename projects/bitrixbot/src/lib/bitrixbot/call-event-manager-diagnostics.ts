import { createServiceRoleClient } from "@/lib/supabase/server";
import { normalizeBitrixUserId } from "@/src/lib/bitrixbot/bitrix-user-id";

export type MissingManagerFromCallsDetail = {
  managerBitrixUserId: string;
  callCount: number;
  foundInEmployees: boolean;
  foundInHierarchy: boolean;
  samplePhones: string[];
  sampleOccurredAt: string[];
  sampleCallEventIds: string[];
};

export type CallEventManagerDiagnostics = {
  recentCallEventsAnalyzed: number;
  uniqueManagerBitrixUserIds: number;
  foundInEmployeesTable: number;
  foundInHierarchyCache: number;
  missingFromEmployees: number;
  employeesTableRowCount: number;
  hierarchyCacheRowCount: number;
  lookedUpInTables: string[];
  /** Менеджеры из звонков, которых нет в employees (как при employee_not_found). */
  missingManagers: MissingManagerFromCallsDetail[];
};

const DEFAULT_RECENT = 400;

export async function getCallEventManagerDiagnostics(
  recentLimit = DEFAULT_RECENT
): Promise<CallEventManagerDiagnostics> {
  const supabase = createServiceRoleClient();
  const lookedUpInTables = [
    "public.employees (колонка bitrix_user_id)",
    "public.org_resolved_hierarchy (колонка manager_bitrix_user_id)"
  ];

  const [{ count: empTotal }, { count: hierTotal }] = await Promise.all([
    supabase.from("employees").select("id", { count: "exact", head: true }),
    supabase.from("org_resolved_hierarchy").select("manager_bitrix_user_id", { count: "exact", head: true })
  ]);

  const { data: events, error: evErr } = await supabase
    .from("call_events")
    .select("id, occurred_at, phone_normalized, manager_bitrix_user_id")
    .eq("status", "missed")
    .eq("call_direction", "inbound")
    .not("manager_bitrix_user_id", "is", null)
    .order("occurred_at", { ascending: false })
    .limit(recentLimit);

  if (evErr) throw new Error(evErr.message);

  const rows = (events ?? []) as Array<{
    id: string;
    occurred_at: string;
    phone_normalized: string | null;
    manager_bitrix_user_id: string | null;
  }>;

  const byManager = new Map<
    string,
    { ids: string[]; phones: string[]; occurred: string[]; callCount: number }
  >();

  for (const r of rows) {
    const mid = normalizeBitrixUserId(r.manager_bitrix_user_id);
    if (!mid) continue;
    let g = byManager.get(mid);
    if (!g) {
      g = { ids: [], phones: [], occurred: [], callCount: 0 };
      byManager.set(mid, g);
    }
    g.callCount++;
    if (g.ids.length < 8) g.ids.push(r.id);
    const ph = r.phone_normalized?.trim() || "";
    if (ph && g.phones.length < 8 && !g.phones.includes(ph)) g.phones.push(ph);
    if (g.occurred.length < 8) g.occurred.push(r.occurred_at);
  }

  const uniqueIds = [...byManager.keys()];
  if (uniqueIds.length === 0) {
    return {
      recentCallEventsAnalyzed: rows.length,
      uniqueManagerBitrixUserIds: 0,
      foundInEmployeesTable: 0,
      foundInHierarchyCache: 0,
      missingFromEmployees: 0,
      employeesTableRowCount: empTotal ?? 0,
      hierarchyCacheRowCount: hierTotal ?? 0,
      lookedUpInTables,
      missingManagers: []
    };
  }

  const [{ data: empHits }, { data: hierHits }] = await Promise.all([
    supabase.from("employees").select("bitrix_user_id").in("bitrix_user_id", uniqueIds),
    supabase
      .from("org_resolved_hierarchy")
      .select("manager_bitrix_user_id")
      .in("manager_bitrix_user_id", uniqueIds)
  ]);

  if (empHits === undefined && hierHits === undefined) {
    /* supabase returns data; errors would throw elsewhere */
  }

  const empSet = new Set(
    (empHits ?? []).map((r) => normalizeBitrixUserId((r as { bitrix_user_id: string }).bitrix_user_id)).filter(Boolean) as string[]
  );
  const hierSet = new Set(
    (hierHits ?? [])
      .map((r) => normalizeBitrixUserId((r as { manager_bitrix_user_id: string }).manager_bitrix_user_id))
      .filter(Boolean) as string[]
  );

  const missingManagers: MissingManagerFromCallsDetail[] = [];
  for (const id of uniqueIds) {
    const inE = empSet.has(id);
    const inH = hierSet.has(id);
    if (inE) continue;
    const g = byManager.get(id)!;
    missingManagers.push({
      managerBitrixUserId: id,
      callCount: g.callCount,
      foundInEmployees: inE,
      foundInHierarchy: inH,
      samplePhones: g.phones,
      sampleOccurredAt: g.occurred,
      sampleCallEventIds: g.ids
    });
  }

  missingManagers.sort((a, b) => b.callCount - a.callCount);

  return {
    recentCallEventsAnalyzed: rows.length,
    uniqueManagerBitrixUserIds: uniqueIds.length,
    foundInEmployeesTable: uniqueIds.filter((id) => empSet.has(id)).length,
    foundInHierarchyCache: uniqueIds.filter((id) => hierSet.has(id)).length,
    missingFromEmployees: missingManagers.length,
    employeesTableRowCount: empTotal ?? 0,
    hierarchyCacheRowCount: hierTotal ?? 0,
    lookedUpInTables,
    missingManagers
  };
}
