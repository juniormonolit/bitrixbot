import { runWithBitrixRestContext } from "@/lib/bitrix/bitrix-rest-context";
import {
  getManagerBitrixRestBaseUrl,
  managerBitrixCallWithMeta
} from "@/lib/bitrix/manager-bitrix-client";
import { createServiceRoleClient } from "@/lib/supabase/server";

export const DEFAULT_MANAGERS_LIST_METHOD = "mlt.managers.list";

const CACHE_KEY = "default";
const MAX_LIST_PAGES = 5;

export type ManagersListSlimRow = {
  ID: string;
  LOGIN: string | null;
  NAME: string;
  LAST_NAME: string;
  ACTIVE: unknown;
  USER_TYPE: string | null;
  UF_DEPARTMENT: unknown;
  WORK_DEPARTMENT: unknown;
};

export type BitrixUserLike = ManagersListSlimRow;

export function getManagersListRestMethod(): string | null {
  const method = process.env.BITRIX_USER_LOGINS_REST_METHOD?.trim();
  if (!method) return null;
  if (!getManagerBitrixRestBaseUrl()) return null;
  return method;
}

export function isManagersListSyncConfigured(): boolean {
  return Boolean(getManagersListRestMethod());
}

function getCacheTtlMs(): number {
  const hours = Number(process.env.ORG_MANAGERS_LIST_CACHE_TTL_HOURS ?? "24");
  if (!Number.isFinite(hours) || hours <= 0) return 24 * 60 * 60 * 1000;
  return hours * 60 * 60 * 1000;
}

function toSlimRow(raw: Record<string, unknown>): ManagersListSlimRow | null {
  const id = raw.ID == null ? "" : String(raw.ID).trim();
  if (!id) return null;
  const loginRaw = raw.LOGIN;
  const login =
    loginRaw === null || loginRaw === undefined ? null : String(loginRaw).trim() || null;
  return {
    ID: id,
    LOGIN: login,
    NAME: String(raw.NAME ?? ""),
    LAST_NAME: String(raw.LAST_NAME ?? ""),
    ACTIVE: raw.ACTIVE,
    USER_TYPE: typeof raw.USER_TYPE === "string" ? raw.USER_TYPE : null,
    UF_DEPARTMENT: raw.UF_DEPARTMENT,
    WORK_DEPARTMENT: raw.WORK_DEPARTMENT
  };
}

async function fetchManagersListFromBitrix(method: string): Promise<ManagersListSlimRow[]> {
  const rows: ManagersListSlimRow[] = [];
  let start = 0;
  let pagesFetched = 0;
  const seenStarts = new Set<number>();

  while (pagesFetched < MAX_LIST_PAGES) {
    if (seenStarts.has(start)) break;
    seenStarts.add(start);

    const { result, next } = await managerBitrixCallWithMeta<unknown[]>(method, { start });
    const chunk = Array.isArray(result) ? result : [];
    for (const item of chunk) {
      if (!item || typeof item !== "object") continue;
      const slim = toSlimRow(item as Record<string, unknown>);
      if (slim) rows.push(slim);
    }

    pagesFetched += 1;
    console.log(
      `[bitrix-org-sync] managers_list bitrix page start=${start} count=${chunk.length} slimTotal=${rows.length} next=${next ?? "null"}`
    );

    if (chunk.length === 0) break;
    const nextNum =
      next !== undefined && next !== null && Number.isFinite(Number(next)) ? Number(next) : null;
    if (nextNum !== null) {
      if (nextNum === start) break;
      start = nextNum;
      continue;
    }
    break;
  }

  return rows;
}

async function readCache(): Promise<{ rows: ManagersListSlimRow[]; fetchedAt: string } | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("bitrix_managers_list_cache")
    .select("rows, fetched_at")
    .eq("cache_key", CACHE_KEY)
    .maybeSingle();
  if (error) throw new Error(`managers_list cache read failed: ${error.message}`);
  if (!data?.fetched_at) return null;
  const rawRows = data.rows;
  if (!Array.isArray(rawRows)) return null;
  const rows = rawRows
    .map((r) => (r && typeof r === "object" ? toSlimRow(r as Record<string, unknown>) : null))
    .filter((r): r is ManagersListSlimRow => Boolean(r));
  return { rows, fetchedAt: String(data.fetched_at) };
}

async function writeCache(rows: ManagersListSlimRow[]): Promise<string> {
  const supabase = createServiceRoleClient();
  const fetchedAt = new Date().toISOString();
  const { error } = await supabase.from("bitrix_managers_list_cache").upsert(
    {
      cache_key: CACHE_KEY,
      rows,
      row_count: rows.length,
      fetched_at: fetchedAt
    },
    { onConflict: "cache_key" }
  );
  if (error) throw new Error(`managers_list cache write failed: ${error.message}`);
  return fetchedAt;
}

export type GetManagersListForSyncResult = {
  users: ManagersListSlimRow[];
  source: "cache" | "bitrix";
  fetchedAt: string;
  rowCount: number;
  pagesFetched: number;
};

/**
 * Single source for employee sync: mlt.managers.list with Supabase slim cache.
 */
export async function getManagersListForSync(options?: {
  force?: boolean;
}): Promise<GetManagersListForSyncResult> {
  const method = getManagersListRestMethod();
  if (!method) {
    throw new Error("Managers list sync not configured (BITRIX_USER_LOGINS_REST_METHOD + MANAGER_BITRIX_REST_BASE_URL)");
  }

  return runWithBitrixRestContext("daily_company_structure_sync", async () => {
    const force = options?.force === true;
    const ttlMs = getCacheTtlMs();

    if (!force) {
      const cached = await readCache();
      if (cached) {
        const ageMs = Date.now() - new Date(cached.fetchedAt).getTime();
        if (ageMs >= 0 && ageMs < ttlMs) {
          console.log("[bitrix-org-sync] managers_list cache_hit", {
            rowCount: cached.rows.length,
            fetchedAt: cached.fetchedAt,
            ageMinutes: Math.round(ageMs / 60_000)
          });
          return {
            users: cached.rows,
            source: "cache",
            fetchedAt: cached.fetchedAt,
            rowCount: cached.rows.length,
            pagesFetched: 0
          };
        }
      }
    }

    console.log("[bitrix-org-sync] managers_list cache_miss", { method, force });
    const rows = await fetchManagersListFromBitrix(method);
    const fetchedAt = await writeCache(rows);
    console.log("[bitrix-org-sync] managers_list cache_written", { rowCount: rows.length, fetchedAt });

    return {
      users: rows,
      source: "bitrix",
      fetchedAt,
      rowCount: rows.length,
      pagesFetched: 1
    };
  });
}

/** @deprecated Use getManagersListForSync — kept for probe script compatibility. */
export async function fetchBitrixUserLoginsMap(method: string): Promise<{
  loginByBitrixUserId: Map<string, string>;
  rowsFetched: number;
  pagesFetched: number;
}> {
  const { users, pagesFetched } = await getManagersListForSync({ force: true });
  const loginByBitrixUserId = new Map<string, string>();
  for (const u of users) {
    if (u.ID && u.LOGIN) loginByBitrixUserId.set(u.ID, u.LOGIN);
  }
  return { loginByBitrixUserId, rowsFetched: loginByBitrixUserId.size, pagesFetched };
}
