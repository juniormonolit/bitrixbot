import { NextResponse } from "next/server";

function tryParseJson(value: string): unknown {
  const v = value.trim();
  if (!v) return value;
  if (
    (v.startsWith("{") && v.endsWith("}")) ||
    (v.startsWith("[") && v.endsWith("]"))
  ) {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return value;
    }
  }
  return value;
}

function redactSecrets(input: unknown): unknown {
  const shouldRedactKey = (k: string) =>
    /token|secret|key|password|refresh|access/i.test(k);

  if (Array.isArray(input)) return input.map(redactSecrets);
  if (!input || typeof input !== "object") return input;

  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (shouldRedactKey(k)) out[k] = "***";
    else out[k] = redactSecrets(v);
  }
  return out;
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const contentType = req.headers.get("content-type") ?? "";

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const raw = await req.text();
    const params = new URLSearchParams(raw);
    const data: Record<string, unknown> = {};
    for (const [k, v] of params.entries()) data[k] = tryParseJson(v);
    return data;
  }

  if (contentType.includes("application/json")) {
    const json = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return json ?? {};
  }

  const text = await req.text().catch(() => "");
  return text ? { raw: text } : {};
}

export async function POST(req: Request) {
  try {
    const body = await readBody(req);

    const event =
      (body.event as string | undefined) ??
      (body.EVENT as string | undefined) ??
      "";

    const data = body.data ?? body.DATA ?? null;
    const auth = body.auth ?? body.AUTH ?? null;

    console.log("[bitrix-bot-handler]", {
      event,
      data: redactSecrets(data),
      auth: redactSecrets(auth)
    });

    if (event === "ONAPPINSTALL") {
      return NextResponse.json({ result: true });
    }

    if (event === "ONIMBOTMESSAGEADD") {
      return NextResponse.json({ reply: "Bitrixbot активен" });
    }

    return NextResponse.json({ result: true });
  } catch (e) {
    console.log("[bitrix-bot-handler] error", {
      message: e instanceof Error ? e.message : String(e)
    });
    return NextResponse.json({ result: true });
  }
}

