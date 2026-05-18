import { createServiceRoleClient } from "@/lib/supabase/server";
import { fetchAllByRange } from "@/src/lib/supabase/fetch-all-by-range";
import { normalizeBitrixUserId, bitrixUserIdLookupCandidates } from "@/src/lib/bitrixbot/bitrix-user-id";

type DepartmentRow = {
  id: string; // uuid
  bitrix_department_id: string;
  name: string;
  parent_bitrix_department_id: string | null;
  head_bitrix_user_id: string | null;
  director_bitrix_user_id: string | null;
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
  | "department_chain"
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
  const n = normalizeBitrixUserId(bitrixUserId);
  if (!n) return null;
  const direct = employeeByBitrixUserId.get(n)?.name;
  if (direct) return direct;
  for (const e of employeeByBitrixUserId.values()) {
    if (normalizeBitrixUserId(e.bitrix_user_id) === n) return e.name ?? null;
  }
  return null;
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

function leaderCandidateForDepartment(
  dept: DepartmentRow,
  overrides: OverrideRow[],
  role: "rop" | "department_director"
): string | null {
  const ov = findOverride(overrides, role, dept.id);
  if (ov) return normalizeBitrixUserId(ov.bitrix_user_id);
  const head = normalizeBitrixUserId(dept.head_bitrix_user_id);
  if (head) return head;
  return normalizeBitrixUserId(dept.director_bitrix_user_id);
}

function findRopFromChain(
  chain: DepartmentRow[],
  employeeBitrixUserId: string,
  overrides: OverrideRow[]
): { ropId: string | null; ropDeptIndex: number } {
  const emp = normalizeBitrixUserId(employeeBitrixUserId);
  for (let i = 0; i < chain.length; i++) {
    const cand = leaderCandidateForDepartment(chain[i], overrides, "rop");
    if (!cand) continue;
    if (emp && cand === emp) continue;
    return { ropId: cand, ropDeptIndex: i };
  }
  return { ropId: null, ropDeptIndex: -1 };
}

function findDepartmentDirectorFromChain(
  chain: DepartmentRow[],
  employeeBitrixUserId: string,
  ropId: string | null,
  ropDeptIndex: number,
  overrides: OverrideRow[]
): string | null {
  const emp = normalizeBitrixUserId(employeeBitrixUserId);
  const rop = ropId ? normalizeBitrixUserId(ropId) : null;
  const start = ropDeptIndex >= 0 ? ropDeptIndex + 1 : 0;
  for (let j = start; j < chain.length; j++) {
    const cand = leaderCandidateForDepartment(chain[j], overrides, "department_director");
    if (!cand) continue;
    if (emp && cand === emp) continue;
    if (rop && cand === rop) continue;
    return cand;
  }
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

  let ropId = normalizeBitrixUserId(employee.rop_bitrix_user_id);
  let ropSource: Source = ropId ? "employee_field" : "null";
  let ropDeptIndex = -1;
  if (!ropId) {
    const r = findRopFromChain(chain, employee.bitrix_user_id, overrides);
    ropId = r.ropId;
    ropDeptIndex = r.ropDeptIndex;
    if (ropId) ropSource = "department_chain";
  }

  let deptDirectorId = normalizeBitrixUserId(employee.department_director_bitrix_user_id);
  let deptDirectorSource: Source = deptDirectorId ? "employee_field" : "null";
  if (!deptDirectorId) {
    const fromOv = findOverrideInChain(overrides, "department_director", chain);
    if (fromOv) {
      deptDirectorId = normalizeBitrixUserId(fromOv.bitrix_user_id);
      deptDirectorSource = fromOv.source;
    }
  }
  if (!deptDirectorId) {
    const fromChain = findDepartmentDirectorFromChain(
      chain,
      employee.bitrix_user_id,
      ropId,
      ropDeptIndex,
      overrides
    );
    if (fromChain) {
      deptDirectorId = fromChain;
      deptDirectorSource = "department_chain";
    }
  }

  let companyDirectorId = normalizeBitrixUserId(employee.company_director_bitrix_user_id);
  let companyDirectorSource: Source = companyDirectorId ? "employee_field" : "null";
  if (!companyDirectorId) {
    const ov = findOverride(overrides, "company_director", null);
    if (ov) {
      companyDirectorId = normalizeBitrixUserId(ov.bitrix_user_id);
      companyDirectorSource = ov.source;
    }
  }

  const chainBitrixIds = chain.map((d) => d.bitrix_department_id);

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
      debug: {
        department_chain_bitrix_ids: chainBitrixIds,
        resolved_rop: ropId,
        resolved_department_director: deptDirectorId,
        resolved_company_director: companyDirectorId,
        rop_dept_index: ropDeptIndex
      },
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
  /** Rows with resolved РОП (chain / field / override). */
  resolvedRopCount: number;
  /** Rows without РОП after resolution. */
  unresolvedRopCount: number;
  /** Rows with department-level director (not company). */
  resolvedDepartmentDirectorCount: number;
  unresolvedDepartmentDirectorCount: number;
  /** Rows with company director set. */
  resolvedCompanyDirectorCount: number;
  /** Legacy aliases (same values as above). */
  processedEmployees: number;
  updatedRows: number;
  skippedRows: number;
  warnings: string[];
};

async function fetchOrgHierarchySourceRows(
  supabase: ReturnType<typeof createServiceRoleClient>
): Promise<{
  employeeRows: EmployeeRow[];
  departmentRows: DepartmentRow[];
  overrideRows: OverrideRow[];
}> {
  const employeeSelect =
    "id, bitrix_user_id, name, department_id, rop_bitrix_user_id, department_director_bitrix_user_id, company_director_bitrix_user_id";
  const employeeRows = await fetchAllByRange<EmployeeRow>({
    pageSize: SELECT_PAGE_SIZE,
    fetchPage: (from, to) =>
      supabase.from("employees").select(employeeSelect).order("id", { ascending: true }).range(from, to)
  });

  const departmentSelect =
    "id, bitrix_department_id, name, parent_bitrix_department_id, head_bitrix_user_id, director_bitrix_user_id";
  const departmentRows = await fetchAllByRange<DepartmentRow>({
    pageSize: SELECT_PAGE_SIZE,
    fetchPage: (from, to) =>
      supabase.from("departments").select(departmentSelect).order("id", { ascending: true }).range(from, to)
  });

  const overrideRows = await fetchAllByRange<OverrideRow>({
    pageSize: SELECT_PAGE_SIZE,
    fetchPage: (from, to) =>
      supabase
        .from("org_role_overrides")
        .select("bitrix_user_id, role_key, department_id, is_active")
        .eq("is_active", true)
        .order("bitrix_user_id", { ascending: true })
        .range(from, to)
  });

  return { employeeRows, departmentRows, overrideRows };
}

export async function rebuildOrgResolvedHierarchy(): Promise<RebuildHierarchyResult> {
  const supabase = createServiceRoleClient();
  const warnings: string[] = [];

  const { employeeRows, departmentRows, overrideRows } = await fetchOrgHierarchySourceRows(supabase);

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
    const k = normalizeBitrixUserId(row.manager_bitrix_user_id) ?? row.manager_bitrix_user_id;
    byManager.set(k, row);
  }
  const uniqueResolved = [...byManager.values()];
  if (uniqueResolved.length !== resolved.length) {
    warnings.push(
      `dedupe_hierarchy_rows: raw=${resolved.length} unique_manager=${uniqueResolved.length} (duplicate manager_bitrix_user_id in batch)`
    );
  }

  const countCoverage = (rows: ResolvedHierarchyRow[]) => {
    const n = rows.length;
    let resolvedRopCount = 0;
    let resolvedDepartmentDirectorCount = 0;
    let resolvedCompanyDirectorCount = 0;
    for (const row of rows) {
      if (normalizeBitrixUserId(row.rop_bitrix_user_id)) resolvedRopCount++;
      if (normalizeBitrixUserId(row.department_director_bitrix_user_id)) resolvedDepartmentDirectorCount++;
      if (normalizeBitrixUserId(row.company_director_bitrix_user_id)) resolvedCompanyDirectorCount++;
    }
    return {
      resolvedRopCount,
      unresolvedRopCount: n - resolvedRopCount,
      resolvedDepartmentDirectorCount,
      unresolvedDepartmentDirectorCount: n - resolvedDepartmentDirectorCount,
      resolvedCompanyDirectorCount
    };
  };

  const coverage = countCoverage(uniqueResolved);
  console.log(`${LOG} summary`, {
    total_employees_unique: dedupedEmployees.length,
    hierarchy_rows: uniqueResolved.length,
    ...coverage
  });

  if (uniqueResolved.length + skippedRows !== dedupedEmployees.length) {
    warnings.push(
      `hierarchy_row_count_mismatch: employees_unique=${dedupedEmployees.length} hierarchy_rows=${uniqueResolved.length} skipped_no_bitrix_id=${skippedRows}`
    );
  }

  let samples = 0;
  for (const row of uniqueResolved) {
    if (!row.department_id) continue;
    if (samples++ >= 8) break;
    const dbg = row.resolved_path.debug as { department_chain_bitrix_ids?: string[] } | undefined;
    const chainStr = (dbg?.department_chain_bitrix_ids ?? []).join(",");
    console.log(
      `${LOG} employee=${row.manager_bitrix_user_id} department=${row.department_id ?? "null"} department_chain=[${chainStr}] resolved_rop=${row.rop_bitrix_user_id ?? "null"} resolved_director=${row.department_director_bitrix_user_id ?? row.company_director_bitrix_user_id ?? "null"}`
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
    const emptyCov = countCoverage(uniqueResolved);
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
      ...emptyCov,
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
    ...coverage,
    processedEmployees: dedupedEmployees.length,
    updatedRows: uniqueResolved.length,
    skippedRows,
    warnings
  };
}

/** For GET /api/debug/alerting/org-lookup — same resolution as rebuild, without writing DB. */
export async function debugComputeHierarchyForBitrixUser(bitrixUserId: string): Promise<{
  employeeFound: boolean;
  hierarchyRowFromDb: Record<string, unknown> | null;
  computed: ResolvedHierarchyRow | null;
  employeesLoaded: number;
  departmentsLoaded: number;
  overridesLoaded: number;
}> {
  const supabase = createServiceRoleClient();
  const candidates = bitrixUserIdLookupCandidates(bitrixUserId.trim());

  const [{ employeeRows, departmentRows, overrideRows }, { data: hierRows }] = await Promise.all([
    fetchOrgHierarchySourceRows(supabase),
    supabase.from("org_resolved_hierarchy").select("*").in("manager_bitrix_user_id", candidates).limit(1)
  ]);

  const departmentById = new Map<string, DepartmentRow>();
  const departmentByBitrixId = new Map<string, DepartmentRow>();
  for (const d of departmentRows) {
    departmentById.set(d.id, d);
    departmentByBitrixId.set(d.bitrix_department_id, d);
  }

  const employeeByBitrixUserId = new Map<string, EmployeeRow>();
  for (const e of employeeRows) {
    if (!e.bitrix_user_id) continue;
    if (!employeeByBitrixUserId.has(e.bitrix_user_id)) employeeByBitrixUserId.set(e.bitrix_user_id, e);
  }

  let emp: EmployeeRow | null = null;
  for (const c of candidates) {
    const hit = employeeByBitrixUserId.get(c);
    if (hit) {
      emp = hit;
      break;
    }
  }

  const hierarchyRowFromDb = (hierRows?.[0] as Record<string, unknown> | undefined) ?? null;
  if (!emp?.bitrix_user_id) {
    return {
      employeeFound: Boolean(emp),
      hierarchyRowFromDb,
      computed: null,
      employeesLoaded: employeeRows.length,
      departmentsLoaded: departmentRows.length,
      overridesLoaded: overrideRows.length
    };
  }

  const computed = resolveHierarchyForEmployee(
    emp,
    { departmentById, departmentByBitrixId },
    overrideRows,
    employeeByBitrixUserId
  );

  return {
    employeeFound: true,
    hierarchyRowFromDb,
    computed,
    employeesLoaded: employeeRows.length,
    departmentsLoaded: departmentRows.length,
    overridesLoaded: overrideRows.length
  };
}
