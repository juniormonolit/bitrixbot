import { bitrixCall } from "@/lib/bitrix/client";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { resolveBitrixUserDepartmentIds } from "@/lib/bitrix/bitrix-user-departments";

export { normalizeDepartmentIdList, resolveBitrixUserDepartmentIds } from "@/lib/bitrix/bitrix-user-departments";

type BitrixDepartment = {
  ID: string | number;
  NAME?: string;
  PARENT?: string | number | null;
};

type BitrixUser = {
  ID: string | number;
  NAME?: string;
  LAST_NAME?: string;
  ACTIVE?: unknown;
  UF_DEPARTMENT?: unknown;
  WORK_DEPARTMENT?: unknown;
  USER_TYPE?: string | null;
};

function toStringId(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

const USER_GET_SELECT = [
  "ID",
  "NAME",
  "LAST_NAME",
  "ACTIVE",
  "UF_DEPARTMENT",
  "WORK_DEPARTMENT",
  "USER_TYPE"
] as const;

function isActiveBitrixUser(active: unknown): boolean {
  if (active === true || active === "Y" || active === "y" || active === 1 || active === "1") return true;
  if (active === false || active === "N" || active === "n" || active === 0 || active === "0") return false;
  return true;
}

function normalizeUserType(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

export async function fetchBitrixDepartments(): Promise<
  { bitrix_department_id: string; name: string; parent_bitrix_department_id: string | null }[]
> {
  const raw = await bitrixCall<BitrixDepartment[]>("department.get", {
    sort: "ID",
    order: "ASC"
  });

  return raw.map((d) => ({
    bitrix_department_id: String(d.ID),
    name: String(d.NAME ?? ""),
    parent_bitrix_department_id: toStringId(d.PARENT ?? null)
  }));
}

/**
 * Portal users for org sync. Does not filter ACTIVE here — callers filter and log skips.
 * Requests UF_DEPARTMENT / WORK_DEPARTMENT explicitly (Bitrix omits UFs without `select`).
 */
async function fetchBitrixUsersRawForSync(): Promise<BitrixUser[]> {
  const raw = await bitrixCall<BitrixUser[]>("user.get", {
    sort: "ID",
    order: "ASC",
    select: [...USER_GET_SELECT]
  });
  return Array.isArray(raw) ? raw : [];
}

export async function fetchBitrixUsers(): Promise<
  { bitrix_user_id: string; name: string; bitrix_department_id: string | null }[]
> {
  const raw = await fetchBitrixUsersRawForSync();
  return raw
    .filter((u) => isActiveBitrixUser(u.ACTIVE))
    .map((u) => {
      const deptIds = resolveBitrixUserDepartmentIds(u.UF_DEPARTMENT, u.WORK_DEPARTMENT);
      const fullName = `${u.NAME ?? ""} ${u.LAST_NAME ?? ""}`.trim();
      return {
        bitrix_user_id: String(u.ID),
        name: fullName || String(u.ID),
        bitrix_department_id: deptIds[0] ?? null
      };
    });
}

export async function syncDepartments(): Promise<{ upserted: number }> {
  const departments = await fetchBitrixDepartments();
  const supabase = createServiceRoleClient();

  if (departments.length === 0) {
    console.log("[bitrix-org-sync] departments: nothing to upsert");
    return { upserted: 0 };
  }

  const { error } = await supabase.from("departments").upsert(departments, {
    onConflict: "bitrix_department_id"
  });
  if (error) throw new Error(`Supabase departments upsert failed: ${error.message}`);

  console.log("[bitrix-org-sync] departments upserted", { count: departments.length });
  return { upserted: departments.length };
}

export async function syncEmployees(): Promise<{ upserted: number; skipped: number }> {
  const supabase = createServiceRoleClient();
  const raw = await fetchBitrixUsersRawForSync();

  if (raw.length === 0) {
    console.log("[bitrix-org-sync] employees: nothing to upsert");
    return { upserted: 0, skipped: 0 };
  }

  const { data: deptRows, error: deptErr } = await supabase
    .from("departments")
    .select("id, bitrix_department_id");
  if (deptErr) throw new Error(`Supabase departments select failed: ${deptErr.message}`);

  const deptIdByBitrixId = new Map<string, string>();
  for (const r of deptRows ?? []) {
    if (r?.bitrix_department_id && r?.id) {
      deptIdByBitrixId.set(String(r.bitrix_department_id), String(r.id));
    }
  }

  type EmployeeUpsert = {
    bitrix_user_id: string;
    name: string;
    department_id: string | null;
    rop_bitrix_user_id: null;
    department_director_bitrix_user_id: null;
    company_director_bitrix_user_id: null;
  };

  const employees: EmployeeUpsert[] = [];
  let skipped = 0;

  for (const u of raw) {
    const bitrixUserId = u.ID == null ? "" : String(u.ID).trim();
    if (!bitrixUserId) {
      skipped++;
      console.log(`[bitrix-org-sync] skip_employee_import: bitrixUserId=(empty) reason=invalid_data`);
      continue;
    }

    if (!isActiveBitrixUser(u.ACTIVE)) {
      skipped++;
      console.log(`[bitrix-org-sync] skip_employee_import: bitrixUserId=${bitrixUserId} reason=inactive`);
      continue;
    }

    const userType = normalizeUserType(u.USER_TYPE);
    if (userType === "extranet") {
      skipped++;
      console.log(`[bitrix-org-sync] skip_employee_import: bitrixUserId=${bitrixUserId} reason=extranet`);
      continue;
    }

    const deptBitrixIds = resolveBitrixUserDepartmentIds(u.UF_DEPARTMENT, u.WORK_DEPARTMENT);

    if (deptBitrixIds.length === 0) {
      console.log(`[bitrix-org-sync] warn_employee_import: bitrixUserId=${bitrixUserId} reason=no_department`);
    } else {
      const unknown = deptBitrixIds.filter((id) => !deptIdByBitrixId.has(id));
      if (unknown.length > 0) {
        console.log(
          `[bitrix-org-sync] warn_employee_import: bitrixUserId=${bitrixUserId} reason=unknown_department_id departmentBitrixIds=${unknown.join(
            "|"
          )}`
        );
      }
    }

    const primaryBitrixDept = deptBitrixIds[0] ?? null;
    const department_id = primaryBitrixDept ? deptIdByBitrixId.get(primaryBitrixDept) ?? null : null;

    if (deptBitrixIds.length > 0 && !department_id) {
      console.log(
        `[bitrix-org-sync] warn_employee_import: bitrixUserId=${bitrixUserId} reason=department_not_in_cache primaryBitrixDept=${primaryBitrixDept} (sync departments first)`
      );
    }

    const fullName = `${u.NAME ?? ""} ${u.LAST_NAME ?? ""}`.trim();
    employees.push({
      bitrix_user_id: bitrixUserId,
      name: fullName || bitrixUserId,
      department_id,
      rop_bitrix_user_id: null,
      department_director_bitrix_user_id: null,
      company_director_bitrix_user_id: null
    });
  }

  if (employees.length === 0) {
    console.log("[bitrix-org-sync] employees: nothing to upsert after filters", { skipped });
    return { upserted: 0, skipped };
  }

  const { error } = await supabase.from("employees").upsert(employees, {
    onConflict: "bitrix_user_id"
  });
  if (error) throw new Error(`Supabase employees upsert failed: ${error.message}`);

  const withDepartment = employees.filter((e) => Boolean(e.department_id)).length;
  console.log("[bitrix-org-sync] employees upserted", {
    count: employees.length,
    withDepartment,
    skipped
  });

  return { upserted: employees.length, skipped };
}
