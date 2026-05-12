import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { processNewMissedCallEvents } from "@/src/lib/bitrixbot/process-new-missed-call-events";

const ROUTE_LOG = "[alerting:process-missed-calls:route]";

function isAuthorized(req: Request): boolean {
  const header = req.headers.get("x-debug-secret") ?? "";
  const url = new URL(req.url);
  const query = url.searchParams.get("secret") ?? "";
  const secret = header || query;
  return Boolean(secret && secret === env.DEBUG_SECRET);
}

function parseLimitFromBody(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 100;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const l = (parsed as { limit?: unknown }).limit;
      if (typeof l === "number" && Number.isFinite(l)) {
        return l;
      }
    }
  } catch {
    // invalid JSON → default
  }
  return 100;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let limit = 100;
  try {
    const text = await req.text();
    limit = parseLimitFromBody(text);
  } catch {
    limit = 100;
  }

  console.log(`${ROUTE_LOG} start`, { parsedLimit: limit });

  const startedAt = Date.now();
  try {
    const summary = await processNewMissedCallEvents(limit);
    const durationMs = Date.now() - startedAt;
    console.log(`${ROUTE_LOG} success`, { durationMs, summary });
    return NextResponse.json({
      ok: true,
      durationMs,
      summary
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    console.error(`${ROUTE_LOG} error`, msg, stack);
    return NextResponse.json(
      { ok: false, error: msg, durationMs: Date.now() - startedAt },
      { status: 500 }
    );
  }
}
