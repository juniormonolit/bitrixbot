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

const LOG = "[hierarchy-rebuild]";
/** PostgREST / project max-rows may cap a single select (e.g. 50–1000); page until exhausted. */
const SELECT_PAGE_SIZE = 1000;
/** Avoid oversized single upsert payloads. */
const HIERARCHY_UPSERT_BATCH = 250;

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

  let ropId: string | null = employee.rop_bitrix_user_id;
  let ropSource: Source = ropId ? "employee_field" : "null";
  if (!ropId) {
    const ov = findOverride(overrides, "rop", employee.department_id);
    if (ov) {
      ropId = ov.bitrix_user_id;
      ropSource = ov.source;
    }
  }

  let deptDirectorId: string | null = employee.department_director_bitrix_user_id;
  let deptDirectorSource: Source = deptDirectorId ? "employee_field" : "null";
  if (!deptDirectorId) {
    const ov = findOverrideInChain(overrides, "department_director", chain);
    if (ov) {
      deptDirectorId = ov.bitrix_user_id;
      deptDirectorSource = ov.source;
    }
  }

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
  /** Rows read from DB after pagination (may include duplicate bitrix_user_id). */
  employeesRead: number;
  /** Unique employees by bitrix_user_id used to build hierarchy. */
  employeesUnique: number;
  departmentsLoaded: number;
  overridesLoaded: number;
  hierarchyRowsCreated: number;
  /** Rows written to org_resolved_hierarchy (after dedupe by manager_bitrix_user_id). */
  hierarchyRowsUpserted: number;
  skippedEmployees: number;
  /** We always emit a hierarchy row without department; this stays 0 unless logic changes. */
  skippedNoDepartment: number;
  skippedNoManager: number;
  /** Employees included with null department_id (still get a hierarchy row). */
  includedWithoutDepartment: number;
  /** Duplicate bitrix_user_id rows collapsed when deduping. */
  duplicateEmployeeBitrixUserIds: number;
  /** Legacy aliases (same values as above). */
  processedEmployees: number;
  updatedRows: number;
  skippedRows: number;
  warnings: string[];
};

export async function rebuildOrgResolvedHierarchy(): Promise<RebuildHierarchyResult> {
  const supabase = createServiceRoleClient();
  const warnings: string[] = [];

  const employeeSelect =
    "id, bitrix_user_id, name, department_id, rop_bitrix_user_id, department_director_bitrix_user_id, company_director_bitrix_user_id";
  const employeeRows: EmployeeRow[] = [];
  let empFrom = 0;
  while (true) {
    const { data, error: empErr } = await supabase
      .from("employees")
      .select(employeeSelect)
      .order("id", { ascending: true })
      .range(empFrom, empFrom + SELECT_PAGE_SIZE - 1);
    if (empErr) throw new Error(empErr.message);
    const chunk = (data ?? []) as EmployeeRow[];
    employeeRows.push(...chunk);
    if (chunk.length < SELECT_PAGE_SIZE) break;
    empFrom += SELECT_PAGE_SIZE;
  }

  const departmentRows: DepartmentRow[] = [];
  let depFrom = 0;
  while (true) {
    const { data, error: depErr } = await supabase
      .from("departments")
      .select("id, bitrix_department_id, name, parent_bitrix_department_id")
      .order("id", { ascending: true })
      .range(depFrom, depFrom + SELECT_PAGE_SIZE - 1);
    if (depErr) throw new Error(depErr.message);
    const chunk = (data ?? []) as DepartmentRow[];
    departmentRows.push(...chunk);
    if (chunk.length < SELECT_PAGE_SIZE) break;
    depFrom += SELECT_PAGE_SIZE;
  }

  const overrideRows: OverrideRow[] = [];
  let ovFrom = 0;
  while (true) {
    const { data, error: ovErr } = await supabase
      .from("org_role_overrides")
      .select("bitrix_user_id, role_key, department_id, is_active")
      .eq("is_active", true)
      .order("bitrix_user_id", { ascending: true })
      .range(ovFrom, ovFrom + SELECT_PAGE_SIZE - 1);
    if (ovErr) throw new Error(ovErr.message);
    const chunk = (data ?? []) as OverrideRow[];
    overrideRows.push(...chunk);
    if (chunk.length < SELECT_PAGE_SIZE) break;
    ovFrom += SELECT_PAGE_SIZE;
  }

  console.log(`${LOG} employees_loaded`, { employeesRead: employeeRows.length });
  console.log(`${LOG} departments_loaded`, { departmentsLoaded: departmentRows.length });
  console.log(`${LOG} overrides_loaded`, { overridesLoaded: overrideRows.length });

  const departmentById = new Map<string, DepartmentRow>();
  const departmentByBitrixId = new Map<string, DepartmentRow>();
  for (const d of departmentRows) {
    departmentById.set(d.id, d);
    departmentByBitrixId.set(d.bitrix_department_id, d);
  }

  const employeeByBitrixUserId = new Map<string, EmployeeRow>();
  let duplicateEmployeeBitrixUserIds = 0;
  for (const e of employeeRows) {
    if (!e.bitrix_user_id) continue;
    if (employeeByBitrixUserId.has(e.bitrix_user_id)) {
      duplicateEmployeeBitrixUserIds++;
      warnings.push(
        `duplicate_employee_bitrix_user_id: bitrix_user_id=${e.bitrix_user_id} keeping_first_employee_row_id=${employeeByBitrixUserId.get(e.bitrix_user_id)?.id}`
      );
      continue;
    }
    employeeByBitrixUserId.set(e.bitrix_user_id, e);
  }

  const dedupedEmployees = [...employeeByBitrixUserId.values()];
  let includedWithoutDepartment = 0;
  for (const e of dedupedEmployees) {
    if (!e.department_id) includedWithoutDepartment++;
  }

  const resolved: ResolvedHierarchyRow[] = [];
  let skippedRows = 0;

  for (const e of dedupedEmployees) {
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

  const byManager = new Map<string, ResolvedHierarchyRow>();
  for (const row of resolved) {
    byManager.set(row.manager_bitrix_user_id, row);
  }
  const uniqueResolved = [...byManager.values()];
  if (uniqueResolved.length !== resolved.length) {
    warnings.push(
      `dedupe_hierarchy_rows: raw=${resolved.length} unique_manager=${uniqueResolved.length} (duplicate manager_bitrix_user_id in batch)`
    );
  }

  console.log(`${LOG} hierarchy_rows_created`, {
    hierarchyRowsCreated: resolved.length,
    hierarchyRowsUnique: uniqueResolved.length,
    skippedEmployees: skippedRows,
    includedWithoutDepartment,
    duplicateEmployeeBitrixUserIds
  });
  console.log(`${LOG} skipped_no_department=0 (rows are still written without department)`);
  console.log(`${LOG} skipped_no_manager=0`);

  if (uniqueResolved.length === 0) {
    return {
      employeesRead: employeeRows.length,
      employeesUnique: dedupedEmployees.length,
      departmentsLoaded: departmentRows.length,
      overridesLoaded: overrideRows.length,
      hierarchyRowsCreated: 0,
      hierarchyRowsUpserted: 0,
      skippedEmployees: skippedRows,
      skippedNoDepartment: 0,
      skippedNoManager: 0,
      includedWithoutDepartment,
      duplicateEmployeeBitrixUserIds,
      processedEmployees: dedupedEmployees.length,
      updatedRows: 0,
      skippedRows,
      warnings
    };
  }

  for (let i = 0; i < uniqueResolved.length; i += HIERARCHY_UPSERT_BATCH) {
    const batch = uniqueResolved.slice(i, i + HIERARCHY_UPSERT_BATCH);
    const { error: upsertErr } = await supabase.from("org_resolved_hierarchy").upsert(batch, {
      onConflict: "manager_bitrix_user_id"
    });
    if (upsertErr) throw new Error(upsertErr.message);
    console.log(`${LOG} hierarchy_upsert_batch`, {
      offset: i,
      batchSize: batch.length,
      total: uniqueResolved.length
    });
  }

  console.log(`${LOG} hierarchy_rows_upserted`, { count: uniqueResolved.length });

  return {
    employeesRead: employeeRows.length,
    employeesUnique: dedupedEmployees.length,
    departmentsLoaded: departmentRows.length,
    overridesLoaded: overrideRows.length,
    hierarchyRowsCreated: resolved.length,
    hierarchyRowsUpserted: uniqueResolved.length,
    skippedEmployees: skippedRows,
    skippedNoDepartment: 0,
    skippedNoManager: 0,
    includedWithoutDepartment,
    duplicateEmployeeBitrixUserIds,
    processedEmployees: dedupedEmployees.length,
    updatedRows: uniqueResolved.length,
    skippedRows,
    warnings
  };
}
