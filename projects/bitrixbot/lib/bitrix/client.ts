import { env } from "@/lib/env";
import { assertBitrixRestCallAllowed } from "@/lib/bitrix/bitrix-rest-context";

type JsonRecord = Record<string, unknown>;

export type BitrixOkResponse<T = unknown> = {
  result: T;
  time?: unknown;
};

export type BitrixErrorResponse = {
  error: string;
  error_description?: string;
};

export type BitrixListMeta = {
  /** Pass as `start` for the next page (Bitrix list methods). */
  next?: number;
  total?: number;
};

export type BitrixCallMetaResult<T> = {
  result: T;
} & BitrixListMeta;

async function bitrixRequestJson(method: string, body: JsonRecord): Promise<unknown> {
  assertBitrixRestCallAllowed(method);
  const url = `${env.BITRIX_REST_BASE_URL}${method}.json`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bitrix-application-token": env.BITRIX_APPLICATION_TOKEN
    },
    body: JSON.stringify(body),
    cache: "no-store"
  });

  let json: unknown;
  try {
    json = await res.json();
  } catch {
    const text = await res.text().catch(() => "");
    throw new Error(
      `Bitrix REST non-JSON response (status ${res.status}): ${text || "(empty)"}`
    );
  }

  if (!res.ok) {
    throw new Error(
      `Bitrix REST HTTP ${res.status}: ${JSON.stringify(json, null, 2)}`
    );
  }

  const maybeError = json as Partial<BitrixErrorResponse>;
  if (maybeError?.error) {
    const desc = maybeError.error_description
      ? `: ${maybeError.error_description}`
      : "";
    throw new Error(`Bitrix REST error ${maybeError.error}${desc}`);
  }

  const ok = json as Partial<BitrixOkResponse<unknown>>;
  if (!("result" in ok)) {
    throw new Error(
      `Bitrix REST unexpected response shape: ${JSON.stringify(json, null, 2)}`
    );
  }

  return json;
}

/**
 * Bitrix REST call returning only `result` (backward compatible).
 */
export async function bitrixCall<T = unknown>(
  method: string,
  params: JsonRecord = {}
): Promise<T> {
  const json = await bitrixRequestJson(method, { ...params });
  const ok = json as BitrixOkResponse<T>;
  return ok.result;
}

/**
 * Same as {@link bitrixCall} but exposes `next` / `total` for list pagination (`user.get`, `department.get`, …).
 */
export async function bitrixCallWithMeta<T = unknown>(
  method: string,
  params: JsonRecord = {}
): Promise<BitrixCallMetaResult<T>> {
  const json = await bitrixRequestJson(method, { ...params });
  const o = json as BitrixOkResponse<T> & { next?: number; total?: number };
  const next = o.next === undefined || o.next === null ? undefined : Number(o.next);
  const total = o.total === undefined || o.total === null ? undefined : Number(o.total);
  return {
    result: o.result,
    ...(Number.isFinite(next) ? { next } : {}),
    ...(Number.isFinite(total) ? { total } : {})
  };
}
