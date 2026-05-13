import { syncDepartments, syncEmployees } from "@/lib/bitrix/org";
import {
  rebuildOrgResolvedHierarchy,
  type RebuildHierarchyResult
} from "@/src/lib/bitrixbot/resolve-org-hierarchy";

export type SyncOrgStructureFromBitrixResult = {
  departmentsUpserted: number;
  employeesUpserted: number;
  hierarchy: RebuildHierarchyResult;
};

/**
 * Подтянуть департаменты и сотрудников из Bitrix24, затем пересобрать кэш иерархии.
 */
export async function syncOrgStructureFromBitrixAndRebuild(): Promise<SyncOrgStructureFromBitrixResult> {
  const { upserted: departmentsUpserted } = await syncDepartments();
  const { upserted: employeesUpserted } = await syncEmployees();
  const hierarchy = await rebuildOrgResolvedHierarchy();
  return { departmentsUpserted, employeesUpserted, hierarchy };
}
