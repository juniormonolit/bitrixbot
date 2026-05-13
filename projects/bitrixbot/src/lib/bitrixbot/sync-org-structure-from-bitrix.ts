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
