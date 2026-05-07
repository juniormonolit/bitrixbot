import { env } from "@/lib/env";

type JsonRecord = Record<string, unknown>;

export type BitrixOkResponse<T = unknown> = {
  result: T;
  time?: unknown;
};

export type BitrixErrorResponse = {
  error: string;
  error_description?: string;
};

export async function bitrixCall<T = unknown>(
  method: string,
  params: JsonRecord = {}
): Promise<T> {
  const url = `${env.BITRIX_REST_BASE_URL}${method}.json`;

  const body: JsonRecord = { ...params };

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

  const ok = json as BitrixOkResponse<T>;
  if (!("result" in ok)) {
    throw new Error(
      `Bitrix REST unexpected response shape: ${JSON.stringify(json, null, 2)}`
    );
  }

  return ok.result;
}

