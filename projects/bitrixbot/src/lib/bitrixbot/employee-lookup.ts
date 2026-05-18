import { createServiceRoleClient } from "@/lib/supabase/server";
import { bitrixUserIdLookupCandidates, normalizeBitrixUserId } from "@/src/lib/bitrixbot/bitrix-user-id";

export type EmployeeLookupResult = {
  managerName: string | null;
  departmentId: string | null;
  issueCode: "ok" | "manager_bitrix_user_id_missing" | "employee_not_found";
  foundInEmployees: boolean;
  foundInHierarchyCache: boolean;
  /** Кандидаты id, по которым искали в БД (нормализация string/number). */
  lookupCandidates: string[];
};

export async function lookupEmployeeByBitrixUserId(
  bitrixUserId: string | null
): Promise<EmployeeLookupResult> {
  const normalized = normalizeBitrixUserId(bitrixUserId);
  if (!normalized) {
    return {
      managerName: null,
      departmentId: null,
      issueCode: "manager_bitrix_user_id_missing",
      foundInEmployees: false,
      foundInHierarchyCache: false,
      lookupCandidates: []
    };
  }

  const candidates = bitrixUserIdLookupCandidates(normalized);
  const supabase = createServiceRoleClient();

  const { data: empRows, error: empErr } = await supabase
    .from("employees")
    .select("name, department_id, bitrix_user_id")
    .in("bitrix_user_id", candidates)
    .limit(1);
  if (empErr) throw new Error(empErr.message);

  const emp = empRows?.[0] as { name?: string | null; department_id?: string | null } | undefined;

  const { data: hierRows, error: hierErr } = await supabase
    .from("org_resolved_hierarchy")
    .select("manager_bitrix_user_id")
    .in("manager_bitrix_user_id", candidates)
    .limit(1);
  if (hierErr) throw new Error(hierErr.message);
  const inHier = Boolean(hierRows?.length);

  if (emp) {
    return {
      managerName: emp.name ?? null,
      departmentId: emp.department_id ?? null,
      issueCode: "ok",
      foundInEmployees: true,
      foundInHierarchyCache: inHier,
      lookupCandidates: candidates
    };
  }

  return {
    managerName: null,
    departmentId: null,
    issueCode: "employee_not_found",
    foundInEmployees: false,
    foundInHierarchyCache: inHier,
    lookupCandidates: candidates
  };
}
