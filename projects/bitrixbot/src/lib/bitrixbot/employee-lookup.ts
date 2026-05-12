import { createServiceRoleClient } from "@/lib/supabase/server";

export type EmployeeLookupResult = {
  managerName: string | null;
  departmentId: string | null;
  warning: string | null;
};

export async function lookupEmployeeByBitrixUserId(
  bitrixUserId: string | null
): Promise<EmployeeLookupResult> {
  if (!bitrixUserId) {
    return { managerName: null, departmentId: null, warning: "manager_bitrix_user_id_missing" };
  }

  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("employees")
    .select("name, department_id")
    .eq("bitrix_user_id", bitrixUserId)
    .maybeSingle();
  if (error) throw new Error(error.message);

  if (!data) {
    return { managerName: null, departmentId: null, warning: "employee_not_found" };
  }

  return {
    managerName: (data as { name?: string | null }).name ?? null,
    departmentId: (data as { department_id?: string | null }).department_id ?? null,
    warning: null
  };
}

