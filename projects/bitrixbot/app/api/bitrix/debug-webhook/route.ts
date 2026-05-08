import { NextResponse } from "next/server";

function redactHeaders(headers: Headers): Record<string, string> {
  const shouldRedact = (k: string) => /authorization|cookie|token|secret|key/i.test(k);
  const out: Record<string, string> = {};

  for (const [k, v] of headers.entries()) {
    out[k] = shouldRedact(k) ? "***" : v;
  }

  return out;
}

function tryParseJsonText(raw: string): unknown | null {
  const v = raw.trim();
  if (!v) return null;
  if (
    (v.startsWith("{") && v.endsWith("}")) ||
    (v.startsWith("[") && v.endsWith("]"))
  ) {
    try {
      return JSON.parse(v) as unknown;
    } catch {
      return null;
    }
  }
  return null;
}

export async function GET(req: Request) {
  console.log("[bitrix-debug-webhook] GET", {
    url: req.url,
    headers: redactHeaders(req.headers)
  });
  return NextResponse.json({ ok: true, method: "GET" }, { status: 200 });
}

export async function HEAD(req: Request) {
  console.log("[bitrix-debug-webhook] HEAD", {
    url: req.url,
    headers: redactHeaders(req.headers)
  });
  return new Response(null, { status: 200 });
}

export async function POST(req: Request) {
  let rawBody = "";
  try {
    rawBody = await req.text();
  } catch {
    rawBody = "";
  }

  const parsedBody = rawBody ? tryParseJsonText(rawBody) : null;

  console.log("[bitrix-debug-webhook] POST", {
    method: "POST",
    url: req.url,
    headers: redactHeaders(req.headers),
    rawBody,
    parsedBody
  });

  return NextResponse.json({ ok: true, method: "POST" }, { status: 200 });
}

