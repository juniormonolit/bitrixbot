import { assertBitrixRestCallAllowed } from "@/lib/bitrix/bitrix-rest-context";
import type { BitrixCallMetaResult, BitrixErrorResponse, BitrixOkResponse } from "@/lib/bitrix/client";

type JsonRecord = Record<string, unknown>;

/** Incoming webhook base or full URL to mlt.managers.list.json */
export function getManagerBitrixRestBaseUrl(): string | null {
  const v = process.env.MANAGER_BITRIX_REST_BASE_URL?.trim();
  return v || null;
}

/**
 * Resolves POST URL for manager webhook.
 * Supports MANAGER_BITRIX_REST_BASE_URL as directory or full *.json endpoint.
 */
export function resolveManagerBitrixMethodUrl(method: string): string {
  const raw = getManagerBitrixRestBaseUrl();
  if (!raw) {
    throw new Error("MANAGER_BITRIX_REST_BASE_URL is not set");
  }
  if (/\.json$/i.test(raw)) {
    return raw;
  }
  const base = raw.endsWith("/") ? raw : `${raw}/`;
  return `${base}${method}.json`;
}

async function managerBitrixRequestJson(method: string, body: JsonRecord): Promise<unknown> {
  assertBitrixRestCallAllowed(method);
  const url = resolveManagerBitrixMethodUrl(method);

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store"
  });

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Manager Bitrix REST non-JSON (status ${res.status}): ${text || "(empty)"}`
    );
  }

  if (!res.ok) {
    throw new Error(`Manager Bitrix REST HTTP ${res.status}: ${JSON.stringify(json, null, 2)}`);
  }

  const maybeError = json as Partial<BitrixErrorResponse>;
  if (maybeError?.error) {
    const desc = maybeError.error_description ? `: ${maybeError.error_description}` : "";
    throw new Error(`Manager Bitrix REST error ${maybeError.error}${desc}`);
  }

  const ok = json as Partial<BitrixOkResponse<unknown>>;
  if (!("result" in ok)) {
    throw new Error(
      `Manager Bitrix REST unexpected shape: ${JSON.stringify(json, null, 2)}`
    );
  }

  return json;
}

/** Manager incoming webhook list call (no application token). */
export async function managerBitrixCallWithMeta<T = unknown>(
  method: string,
  params: JsonRecord = {}
): Promise<BitrixCallMetaResult<T>> {
  const json = await managerBitrixRequestJson(method, { ...params });
  const o = json as BitrixOkResponse<T> & { next?: number; total?: number };
  const next = o.next === undefined || o.next === null ? undefined : Number(o.next);
  const total = o.total === undefined || o.total === null ? undefined : Number(o.total);
  return {
    result: o.result,
    ...(Number.isFinite(next) ? { next } : {}),
    ...(Number.isFinite(total) ? { total } : {})
  };
}
