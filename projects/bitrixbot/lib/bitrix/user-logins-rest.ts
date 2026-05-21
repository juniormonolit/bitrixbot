import {
  getManagerBitrixRestBaseUrl,
  managerBitrixCallWithMeta
} from "@/lib/bitrix/manager-bitrix-client";

export const DEFAULT_BITRIX_USER_LOGINS_REST_METHOD = "mlt.managers.list";

export type BitrixUserLoginRow = {
  ID: string | number;
  LOGIN?: string;
  NAME?: string;
  LAST_NAME?: string;
};

/** From env; empty = custom LOGIN sync disabled. */
export function getBitrixUserLoginsRestMethod(): string | null {
  const method = process.env.BITRIX_USER_LOGINS_REST_METHOD?.trim();
  if (!method) return null;
  if (!getManagerBitrixRestBaseUrl()) return null;
  return method;
}

export function isBitrixUserLoginsSyncConfigured(): boolean {
  return Boolean(getBitrixUserLoginsRestMethod());
}

const MAX_LIST_PAGES = 200;
const PAGE_SIZE = 50;

/**
 * Loads ID → LOGIN map via on-premise custom REST (see docs/bitrix-login-custom-rest.md).
 */
export async function fetchBitrixUserLoginsMap(method: string): Promise<{
  loginByBitrixUserId: Map<string, string>;
  rowsFetched: number;
  pagesFetched: number;
}> {
  const loginByBitrixUserId = new Map<string, string>();
  let start = 0;
  let pagesFetched = 0;
  const seenStarts = new Set<number>();

  while (pagesFetched < MAX_LIST_PAGES) {
    if (seenStarts.has(start)) break;
    seenStarts.add(start);

    const { result, next, total } = await managerBitrixCallWithMeta<BitrixUserLoginRow[]>(method, {
      start
    });

    const chunk = Array.isArray(result) ? result : [];
    for (const row of chunk) {
      const id = row.ID == null ? "" : String(row.ID).trim();
      const login = row.LOGIN == null ? "" : String(row.LOGIN).trim();
      if (id && login) loginByBitrixUserId.set(id, login);
    }

    pagesFetched += 1;
    console.log(
      `[bitrix-org-sync] user_logins_rest page start=${start} count=${chunk.length} next=${next ?? "null"} total=${total ?? "null"} mapSize=${loginByBitrixUserId.size}`
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

  return {
    loginByBitrixUserId,
    rowsFetched: loginByBitrixUserId.size,
    pagesFetched
  };
}
