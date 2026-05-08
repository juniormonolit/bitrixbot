import { bitrixCall } from "@/lib/bitrix/client";
import { createServiceRoleClient } from "@/lib/supabase/server";

type BitrixDepartment = {
  ID: string | number;
  NAME?: string;
  PARENT?: string | number | null;
};

type BitrixUser = {
  ID: string | number;
  NAME?: string;
  LAST_NAME?: string;
  UF_DEPARTMENT?: unknown;
};

function toStringId(v: string | number | null | undefined): string | null {
  if (v === null || v === undefined) return null;
  return String(v);
}

function normalizeDepartmentIdList(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  return [String(v)].filter(Boolean);
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

export async function fetchBitrixUsers(): Promise<
  { bitrix_user_id: string; name: string; bitrix_department_id: string | null }[]
> {
  const raw = await bitrixCall<BitrixUser[]>("user.get", {
    sort: "ID",
    order: "ASC",
    filter: { ACTIVE: true }
  });

  return raw.map((u) => {
    const firstDeptId = normalizeDepartmentIdList(u.UF_DEPARTMENT)[0] ?? null;
    const fullName = `${u.NAME ?? ""} ${u.LAST_NAME ?? ""}`.trim();
    return {
      bitrix_user_id: String(u.ID),
      name: fullName || String(u.ID),
      bitrix_department_id: firstDeptId
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

export async function syncEmployees(): Promise<{ upserted: number }> {
  const users = await fetchBitrixUsers();
  const supabase = createServiceRoleClient();

  if (users.length === 0) {
    console.log("[bitrix-org-sync] employees: nothing to upsert");
    return { upserted: 0 };
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

  const employees = users.map((u) => ({
    bitrix_user_id: u.bitrix_user_id,
    name: u.name,
    department_id: u.bitrix_department_id
      ? deptIdByBitrixId.get(u.bitrix_department_id) ?? null
      : null,
    rop_bitrix_user_id: null,
    department_director_bitrix_user_id: null,
    company_director_bitrix_user_id: null
  }));

  const { error } = await supabase.from("employees").upsert(employees, {
    onConflict: "bitrix_user_id"
  });
  if (error) throw new Error(`Supabase employees upsert failed: ${error.message}`);

  const withDepartment = employees.filter((e) => Boolean(e.department_id)).length;
  console.log("[bitrix-org-sync] employees upserted", {
    count: employees.length,
    withDepartment
  });

  return { upserted: employees.length };
}

