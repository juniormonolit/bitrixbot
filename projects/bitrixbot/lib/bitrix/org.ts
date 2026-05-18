import { bitrixCallWithMeta } from "@/lib/bitrix/client";
import { runWithBitrixRestContext } from "@/lib/bitrix/bitrix-rest-context";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { fetchAllByRange } from "@/src/lib/supabase/fetch-all-by-range";
import { resolveBitrixUserDepartmentIds } from "@/lib/bitrix/bitrix-user-departments";

export { normalizeDepartmentIdList, resolveBitrixUserDepartmentIds } from "@/lib/bitrix/bitrix-user-departments";

type BitrixDepartment = {
  ID: string | number;
  NAME?: string;
  PARENT?: string | number | null;
  /** Department head (руководитель подразделения) — Bitrix REST. */
  UF_HEAD?: string | number | null;
  HEAD?: string | number | null;
};

type BitrixUser = {
  ID: string | number;
  NAME?: string;
  LAST_NAME?: string;
  SECOND_NAME?: string;
  ACTIVE?: unknown;
  EMAIL?: string;
  WORK_POSITION?: string;
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
  "SECOND_NAME",
  "ACTIVE",
  "EMAIL",
  "WORK_POSITION",
  "UF_DEPARTMENT",
  "WORK_DEPARTMENT",
  "USER_TYPE"
] as const;

/** Bitrix list: safety cap (pages), not total rows. */
const MAX_LIST_PAGES = 200;
const BITRIX_LIST_PAGE_SIZE = 50;

/**
 * Общая пагинация Bitrix list-методов (department.get, user.get, …).
 * Защита от повторяющихся start / подписи страницы и зацикливания next.
 */
async function fetchBitrixListAllPages<T>(options: {
  method: string;
  baseParams: Record<string, unknown>;
  pageSizeFallback: number;
  extractChunk: (result: unknown) => T[];
  pageSignature: (start: number, chunk: T[]) => string;
}): Promise<{ items: T[]; pagesFetched: number; breakReason: string | null }> {
  const { method, baseParams, pageSizeFallback, extractChunk, pageSignature } = options;
  const items: T[] = [];
  let start = 0;
  let pagesFetched = 0;
  const seenStarts = new Set<number>();
  const seenSignatures = new Set<string>();
  let breakReason: string | null = null;

  while (pagesFetched < MAX_LIST_PAGES) {
    if (seenStarts.has(start)) {
      breakReason = "duplicate_start";
      console.warn(
        `[bitrix-org-sync] pagination_break method=${method} reason=${breakReason} start=${start}`
      );
      break;
    }
    seenStarts.add(start);

    const { result, next, total } = await bitrixCallWithMeta<unknown>(method, { ...baseParams, start });
    const chunk = extractChunk(result);
    const sig = pageSignature(start, chunk);
    if (seenSignatures.has(sig)) {
      breakReason = "duplicate_page_signature";
      console.warn(
        `[bitrix-org-sync] pagination_break method=${method} reason=${breakReason} start=${start} signature=${sig}`
      );
      break;
    }
    seenSignatures.add(sig);

    const firstId =
      chunk.length > 0 && typeof (chunk[0] as { ID?: unknown }).ID !== "undefined"
        ? String((chunk[0] as { ID?: unknown }).ID)
        : "—";
    const lastId =
      chunk.length > 0 && typeof (chunk[chunk.length - 1] as { ID?: unknown }).ID !== "undefined"
        ? String((chunk[chunk.length - 1] as { ID?: unknown }).ID)
        : "—";

    console.log(
      `[bitrix-org-sync] page method=${method} start=${start} count=${chunk.length} next=${next ?? "null"} total=${total ?? "null"} firstId=${firstId} lastId=${lastId}`
    );

    if (chunk.length === 0) {
      breakReason = "empty_result";
      console.log(`[bitrix-org-sync] pagination_break method=${method} reason=${breakReason} start=${start}`);
      break;
    }

    items.push(...chunk);
    pagesFetched += 1;

    const nextNum =
      next !== undefined && next !== null && Number.isFinite(Number(next)) ? Number(next) : null;

    if (nextNum !== null) {
      if (nextNum === start) {
        breakReason = "stuck_next_equals_start";
        console.warn(
          `[bitrix-org-sync] pagination_break method=${method} reason=${breakReason} start=${start} next=${nextNum}`
        );
        break;
      }
      start = nextNum;
      continue;
    }

    if (chunk.length < pageSizeFallback) {
      breakReason = "partial_page_no_next";
      console.log(`[bitrix-org-sync] pagination_break method=${method} reason=${breakReason} start=${start}`);
      break;
    }

    if (chunk.length === pageSizeFallback) {
      start += pageSizeFallback;
      continue;
    }

    breakReason = "unexpected_chunk_size";
    console.warn(
      `[bitrix-org-sync] pagination_break method=${method} reason=${breakReason} start=${start} count=${chunk.length}`
    );
    break;
  }

  if (pagesFetched >= MAX_LIST_PAGES && !breakReason) {
    breakReason = "max_list_pages";
    console.warn(`[bitrix-org-sync] pagination_break method=${method} reason=${breakReason} pages=${pagesFetched}`);
  }

  return { items, pagesFetched, breakReason };
}

function isActiveBitrixUser(active: unknown): boolean {
  if (active === true || active === "Y" || active === "y" || active === 1 || active === "1") return true;
  if (active === false || active === "N" || active === "n" || active === 0 || active === "0") return false;
  return true;
}

function normalizeUserType(v: unknown): string {
  return typeof v === "string" ? v.trim().toLowerCase() : "";
}

function mapDepartmentRow(d: BitrixDepartment) {
  const headRaw = d.UF_HEAD ?? d.HEAD ?? null;
  return {
    bitrix_department_id: String(d.ID),
    name: String(d.NAME ?? ""),
    parent_bitrix_department_id: toStringId(d.PARENT ?? null),
    head_bitrix_user_id: toStringId(headRaw),
    director_bitrix_user_id: null as string | null
  };
}

export type FetchBitrixDepartmentsPagedResult = {
  departments: ReturnType<typeof mapDepartmentRow>[];
  departmentsFetchedTotal: number;
  departmentsPagesFetched: number;
};

/**
 * All departments from Bitrix (paginated `department.get`).
 */
export async function fetchBitrixDepartmentsPaged(): Promise<FetchBitrixDepartmentsPagedResult> {
  const { items, pagesFetched } = await fetchBitrixListAllPages<BitrixDepartment>({
    method: "department.get",
    baseParams: { sort: "ID", order: "ASC" },
    pageSizeFallback: BITRIX_LIST_PAGE_SIZE,
    extractChunk: (result) => (Array.isArray(result) ? (result as BitrixDepartment[]) : []),
    pageSignature: (s, chunk) =>
      `${s}:${chunk.length}:${chunk.map((d) => String(d.ID ?? "")).join(",")}`
  });

  const departments = items.map(mapDepartmentRow);
  return {
    departments,
    departmentsFetchedTotal: departments.length,
    departmentsPagesFetched: pagesFetched
  };
}

export async function fetchBitrixDepartments(): Promise<FetchBitrixDepartmentsPagedResult["departments"]> {
  const { departments } = await fetchBitrixDepartmentsPaged();
  return departments;
}

export type FetchBitrixUsersRawForSyncResult = {
  users: BitrixUser[];
  usersFetchedTotal: number;
  usersPagesFetched: number;
};

/**
 * All portal users from Bitrix (paginated `user.get`). No ACTIVE filter — callers filter.
 */
export async function fetchBitrixUsersRawForSync(): Promise<FetchBitrixUsersRawForSyncResult> {
  const baseParams = {
    sort: "ID",
    order: "ASC",
    select: [...USER_GET_SELECT]
  };

  const { items, pagesFetched } = await fetchBitrixListAllPages<BitrixUser>({
    method: "user.get",
    baseParams,
    pageSizeFallback: BITRIX_LIST_PAGE_SIZE,
    extractChunk: (result) => (Array.isArray(result) ? (result as BitrixUser[]) : []),
    pageSignature: (s, chunk) =>
      `${s}:${chunk.length}:${chunk.map((u) => String(u.ID ?? "")).join(",")}`
  });

  return {
    users: items,
    usersFetchedTotal: items.length,
    usersPagesFetched: pagesFetched
  };
}

export async function fetchBitrixUsers(): Promise<
  { bitrix_user_id: string; name: string; bitrix_department_id: string | null }[]
> {
  const { users: raw } = await fetchBitrixUsersRawForSync();
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

export async function syncDepartments(): Promise<{
  upserted: number;
  departmentsFetchedTotal: number;
  departmentsPagesFetched: number;
}> {
  return runWithBitrixRestContext("daily_company_structure_sync", async () => {
    const { departments, departmentsFetchedTotal, departmentsPagesFetched } =
      await fetchBitrixDepartmentsPaged();
    const supabase = createServiceRoleClient();

    if (departments.length === 0) {
      console.log("[bitrix-org-sync] departments: nothing to upsert");
      return { upserted: 0, departmentsFetchedTotal, departmentsPagesFetched };
    }

    const { error } = await supabase.from("departments").upsert(departments, {
      onConflict: "bitrix_department_id"
    });
    if (error) throw new Error(`Supabase departments upsert failed: ${error.message}`);

    console.log("[bitrix-org-sync] departments upserted", {
      count: departments.length,
      departmentsFetchedTotal,
      departmentsPagesFetched
    });
    return { upserted: departments.length, departmentsFetchedTotal, departmentsPagesFetched };
  });
}

export async function syncEmployees(): Promise<{
  upserted: number;
  skipped: number;
  usersFetchedTotal: number;
  usersPagesFetched: number;
}> {
  return runWithBitrixRestContext("daily_company_structure_sync", async () => {
    const supabase = createServiceRoleClient();
    const { users: raw, usersFetchedTotal, usersPagesFetched } = await fetchBitrixUsersRawForSync();

    if (raw.length === 0) {
      console.log("[bitrix-org-sync] employees: nothing to upsert");
      return { upserted: 0, skipped: 0, usersFetchedTotal, usersPagesFetched };
    }

    const deptRows = await fetchAllByRange<{ id: string; bitrix_department_id: string }>({
      pageSize: 500,
      fetchPage: (from, to) =>
        supabase.from("departments").select("id, bitrix_department_id").order("id", { ascending: true }).range(from, to)
    });

    const deptIdByBitrixId = new Map<string, string>();
    for (const r of deptRows) {
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
      return { upserted: 0, skipped, usersFetchedTotal, usersPagesFetched };
    }

    const { error } = await supabase.from("employees").upsert(employees, {
      onConflict: "bitrix_user_id"
    });
    if (error) throw new Error(`Supabase employees upsert failed: ${error.message}`);

    const withDepartment = employees.filter((e) => Boolean(e.department_id)).length;
    console.log("[bitrix-org-sync] employees upserted", {
      count: employees.length,
      withDepartment,
      skipped,
      usersFetchedTotal,
      usersPagesFetched
    });

    return { upserted: employees.length, skipped, usersFetchedTotal, usersPagesFetched };
  });
}
