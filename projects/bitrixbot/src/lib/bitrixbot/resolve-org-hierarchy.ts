import { createServiceRoleClient } from "@/lib/supabase/server";

type DepartmentRow = {
  id: string; // uuid
  bitrix_department_id: string;
  name: string;
  parent_bitrix_department_id: string | null;
};

type EmployeeRow = {
  id: string;
  bitrix_user_id: string;
  name: string;
  department_id: string | null;
  rop_bitrix_user_id: string | null;
  department_director_bitrix_user_id: string | null;
  company_director_bitrix_user_id: string | null;
};

type OverrideRow = {
  bitrix_user_id: string;
  role_key: "rop" | "department_director" | "company_director";
  department_id: string | null;
  is_active: boolean;
};

type RoleKey = OverrideRow["role_key"];

export type ResolvedHierarchyRow = {
  manager_bitrix_user_id: string;
  manager_name: string | null;
  department_id: string | null;
  department_name: string | null;
  rop_bitrix_user_id: string | null;
  rop_name: string | null;
  department_director_bitrix_user_id: string | null;
  department_director_name: string | null;
  company_director_bitrix_user_id: string | null;
  company_director_name: string | null;
  resolved_path: Record<string, unknown>;
  resolved_at: string;
  is_active: boolean;
};

type Source =
  | "employee_field"
  | "override_department"
  | "override_department_chain"
  | "override_global"
  | "null";

function nowIso() {
  return new Date().toISOString();
}

function pickEmployeeNameByBitrixId(
  employeeByBitrixUserId: Map<string, EmployeeRow>,
  bitrixUserId: string | null
): string | null {
  if (!bitrixUserId) return null;
  return employeeByBitrixUserId.get(bitrixUserId)?.name ?? null;
}

function buildDepartmentChain(
  baseDepartmentId: string | null,
  departmentById: Map<string, DepartmentRow>,
  departmentByBitrixId: Map<string, DepartmentRow>
): DepartmentRow[] {
  if (!baseDepartmentId) return [];
  const chain: DepartmentRow[] = [];
  const visited = new Set<string>(); // bitrix_department_id

  let current = departmentById.get(baseDepartmentId) ?? null;
  while (current) {
    if (visited.has(current.bitrix_department_id)) break;
    visited.add(current.bitrix_department_id);
    chain.push(current);

    const parentBitrixId = current.parent_bitrix_department_id;
    if (!parentBitrixId) break;
    current = departmentByBitrixId.get(parentBitrixId) ?? null;
  }

  return chain;
}

function findOverride(
  overrides: OverrideRow[],
  role: RoleKey,
  departmentId: string | null
): { bitrix_user_id: string; source: Source } | null {
  const active = overrides.filter((o) => o.is_active && o.role_key === role);
  if (departmentId) {
    const match = active.find((o) => o.department_id === departmentId);
    if (match) return { bitrix_user_id: match.bitrix_user_id, source: "override_department" };
  }
  const global = active.find((o) => !o.department_id);
  if (global) return { bitrix_user_id: global.bitrix_user_id, source: "override_global" };
  return null;
}

function findOverrideInChain(
  overrides: OverrideRow[],
  role: RoleKey,
  chain: DepartmentRow[]
): { bitrix_user_id: string; source: Source } | null {
  const active = overrides.filter((o) => o.is_active && o.role_key === role);
  for (const d of chain) {
    const match = active.find((o) => o.department_id === d.id);
    if (match) return { bitrix_user_id: match.bitrix_user_id, source: "override_department_chain" };
  }
  const global = active.find((o) => !o.department_id);
  if (global) return { bitrix_user_id: global.bitrix_user_id, source: "override_global" };
  return null;
}

export function resolveHierarchyForEmployee(
  employee: EmployeeRow,
  departments: { departmentById: Map<string, DepartmentRow>; departmentByBitrixId: Map<string, DepartmentRow> },
  overrides: OverrideRow[],
  employeeByBitrixUserId: Map<string, EmployeeRow>
): ResolvedHierarchyRow {
  const chain = buildDepartmentChain(
    employee.department_id,
    departments.departmentById,
    departments.departmentByBitrixId
  );

  const baseDepartment = chain[0] ?? null;

  // rop
  let ropId: string | null = employee.rop_bitrix_user_id;
  let ropSource: Source = ropId ? "employee_field" : "null";
  if (!ropId) {
    const ov = findOverride(overrides, "rop", employee.department_id);
    if (ov) {
      ropId = ov.bitrix_user_id;
      ropSource = ov.source;
    }
  }

  // department director
  let deptDirectorId: string | null = employee.department_director_bitrix_user_id;
  let deptDirectorSource: Source = deptDirectorId ? "employee_field" : "null";
  if (!deptDirectorId) {
    const ov = findOverrideInChain(overrides, "department_director", chain);
    if (ov) {
      deptDirectorId = ov.bitrix_user_id;
      deptDirectorSource = ov.source;
    }
  }

  // company director
  let companyDirectorId: string | null = employee.company_director_bitrix_user_id;
  let companyDirectorSource: Source = companyDirectorId ? "employee_field" : "null";
  if (!companyDirectorId) {
    const ov = findOverride(overrides, "company_director", null);
    if (ov) {
      companyDirectorId = ov.bitrix_user_id;
      companyDirectorSource = ov.source;
    }
  }

  return {
    manager_bitrix_user_id: employee.bitrix_user_id,
    manager_name: employee.name ?? null,
    department_id: baseDepartment?.id ?? null,
    department_name: baseDepartment?.name ?? null,
    rop_bitrix_user_id: ropId,
    rop_name: pickEmployeeNameByBitrixId(employeeByBitrixUserId, ropId),
    department_director_bitrix_user_id: deptDirectorId,
    department_director_name: pickEmployeeNameByBitrixId(employeeByBitrixUserId, deptDirectorId),
    company_director_bitrix_user_id: companyDirectorId,
    company_director_name: pickEmployeeNameByBitrixId(employeeByBitrixUserId, companyDirectorId),
    resolved_path: {
      employee_bitrix_user_id: employee.bitrix_user_id,
      employee_name: employee.name ?? null,
      base_department: baseDepartment
        ? {
            id: baseDepartment.id,
            bitrix_department_id: baseDepartment.bitrix_department_id,
            name: baseDepartment.name
          }
        : null,
      department_chain: chain.map((d) => ({
        id: d.id,
        bitrix_department_id: d.bitrix_department_id,
        name: d.name
      })),
      sources: {
        rop: ropSource,
        department_director: deptDirectorSource,
        company_director: companyDirectorSource
      }
    },
    resolved_at: nowIso(),
    is_active: true
  };
}

export type RebuildHierarchyResult = {
  processedEmployees: number;
  updatedRows: number;
  skippedRows: number;
  warnings: string[];
};

export async function rebuildOrgResolvedHierarchy(): Promise<RebuildHierarchyResult> {
  const supabase = createServiceRoleClient();

  const warnings: string[] = [];

  const { data: employees, error: empErr } = await supabase
    .from("employees")
    .select(
      "id, bitrix_user_id, name, department_id, rop_bitrix_user_id, department_director_bitrix_user_id, company_director_bitrix_user_id"
    );
  if (empErr) throw new Error(empErr.message);

  const { data: departments, error: depErr } = await supabase
    .from("departments")
    .select("id, bitrix_department_id, name, parent_bitrix_department_id");
  if (depErr) throw new Error(depErr.message);

  const { data: overrides, error: ovErr } = await supabase
    .from("org_role_overrides")
    .select("bitrix_user_id, role_key, department_id, is_active")
    .eq("is_active", true);
  if (ovErr) throw new Error(ovErr.message);

  const employeeRows = (employees ?? []) as EmployeeRow[];
  const departmentRows = (departments ?? []) as DepartmentRow[];
  const overrideRows = (overrides ?? []) as OverrideRow[];

  const departmentById = new Map<string, DepartmentRow>();
  const departmentByBitrixId = new Map<string, DepartmentRow>();
  for (const d of departmentRows) {
    departmentById.set(d.id, d);
    departmentByBitrixId.set(d.bitrix_department_id, d);
  }

  const employeeByBitrixUserId = new Map<string, EmployeeRow>();
  for (const e of employeeRows) employeeByBitrixUserId.set(e.bitrix_user_id, e);

  const resolved: ResolvedHierarchyRow[] = [];
  let skippedRows = 0;

  for (const e of employeeRows) {
    if (!e.bitrix_user_id) {
      skippedRows++;
      warnings.push(`Skipped employee without bitrix_user_id (id=${e.id})`);
      continue;
    }
    resolved.push(
      resolveHierarchyForEmployee(
        e,
        { departmentById, departmentByBitrixId },
        overrideRows,
        employeeByBitrixUserId
      )
    );
  }

  if (resolved.length === 0) {
    return {
      processedEmployees: employeeRows.length,
      updatedRows: 0,
      skippedRows,
      warnings
    };
  }

  const { error: upsertErr } = await supabase.from("org_resolved_hierarchy").upsert(resolved, {
    onConflict: "manager_bitrix_user_id"
  });
  if (upsertErr) throw new Error(upsertErr.message);

  return {
    processedEmployees: employeeRows.length,
    updatedRows: resolved.length,
    skippedRows,
    warnings
  };
}

