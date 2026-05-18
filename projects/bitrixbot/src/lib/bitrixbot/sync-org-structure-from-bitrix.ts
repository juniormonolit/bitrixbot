import { syncDepartments, syncEmployees } from "@/lib/bitrix/org";
import {
  rebuildOrgResolvedHierarchy,
  type RebuildHierarchyResult
} from "@/src/lib/bitrixbot/resolve-org-hierarchy";

export type SyncOrgStructureFromBitrixResult = {
  departmentsUpserted: number;
  departmentsFetchedTotal: number;
  departmentsPagesFetched: number;
  employeesUpserted: number;
  employeesSkipped: number;
  usersFetchedTotal: number;
  usersPagesFetched: number;
  hierarchy: RebuildHierarchyResult;
};

/** Для таймаута sync-org-full: последняя стадия и частичный результат. */
export type SyncOrgFullProgress = {
  lastStage: string;
  partial?: {
    departments?: Awaited<ReturnType<typeof syncDepartments>>;
    employees?: Awaited<ReturnType<typeof syncEmployees>>;
    hierarchy?: RebuildHierarchyResult;
  };
};

const LOG = "[sync-org-full]";

/**
 * Подтянуть департаменты и сотрудников из Bitrix24, затем пересобрать кэш иерархии.
 */
export async function syncOrgStructureFromBitrixAndRebuild(): Promise<SyncOrgStructureFromBitrixResult> {
  const {
    upserted: departmentsUpserted,
    departmentsFetchedTotal,
    departmentsPagesFetched
  } = await syncDepartments();
  const {
    upserted: employeesUpserted,
    skipped: employeesSkipped,
    usersFetchedTotal,
    usersPagesFetched
  } = await syncEmployees();
  const hierarchy = await rebuildOrgResolvedHierarchy();
  return {
    departmentsUpserted,
    departmentsFetchedTotal,
    departmentsPagesFetched,
    employeesUpserted,
    employeesSkipped,
    usersFetchedTotal,
    usersPagesFetched,
    hierarchy
  };
}

/**
 * Те же шаги, что sync-org-full, с логами и обновлением progress (для таймаута / диагностики).
 */
export async function syncOrgStructureFromBitrixAndRebuildWithLogs(
  progress: SyncOrgFullProgress
): Promise<SyncOrgStructureFromBitrixResult> {
  progress.lastStage = "sync_departments_start";
  console.log(`${LOG} stage=sync_departments_start`);
  const tDept = Date.now();
  const departments = await syncDepartments();
  progress.partial = { ...progress.partial, departments };
  progress.lastStage = "sync_departments_done";
  console.log(`${LOG} stage=sync_departments_done durationMs=${Date.now() - tDept}`);

  progress.lastStage = "sync_employees_start";
  console.log(`${LOG} stage=sync_employees_start`);
  const tEmp = Date.now();
  const employees = await syncEmployees();
  progress.partial = { ...progress.partial, employees };
  progress.lastStage = "sync_employees_done";
  console.log(`${LOG} stage=sync_employees_done durationMs=${Date.now() - tEmp}`);

  progress.lastStage = "rebuild_hierarchy_start";
  console.log(`${LOG} stage=rebuild_hierarchy_start`);
  const tHier = Date.now();
  const hierarchy = await rebuildOrgResolvedHierarchy();
  progress.partial = { ...progress.partial, hierarchy };
  progress.lastStage = "rebuild_hierarchy_done";
  console.log(`${LOG} stage=rebuild_hierarchy_done durationMs=${Date.now() - tHier}`);

  return {
    departmentsUpserted: departments.upserted,
    departmentsFetchedTotal: departments.departmentsFetchedTotal,
    departmentsPagesFetched: departments.departmentsPagesFetched,
    employeesUpserted: employees.upserted,
    employeesSkipped: employees.skipped,
    usersFetchedTotal: employees.usersFetchedTotal,
    usersPagesFetched: employees.usersPagesFetched,
    hierarchy
  };
}
