import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { skipInvalidPendingDeliveries } from "@/src/lib/bitrixbot/skip-invalid-pending-deliveries";

const ROUTE_LOG = "[alerting:skip-invalid-pending-deliveries:route]";

function isAuthorized(req: Request): boolean {
  const header = req.headers.get("x-debug-secret") ?? "";
  const url = new URL(req.url);
  const query = url.searchParams.get("secret") ?? "";
  const secret = header || query;
  return Boolean(secret && secret === env.DEBUG_SECRET);
}

function parseLimit(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 500;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const l = (parsed as { limit?: unknown }).limit;
      if (typeof l === "number" && Number.isFinite(l)) {
        return Math.max(1, Math.min(5000, Math.floor(l)));
      }
    }
  } catch {
    // default
  }
  return 500;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let limit = 500;
  try {
    const text = await req.text();
    limit = parseLimit(text);
  } catch {
    limit = 500;
  }

  console.log(`${ROUTE_LOG} start`, { limit });
  const startedAt = Date.now();
  try {
    const supabase = createServiceRoleClient();
    const summary = await skipInvalidPendingDeliveries(supabase, limit, 30);
    const durationMs = Date.now() - startedAt;
    console.log(`${ROUTE_LOG} success`, { durationMs, summary });
    return NextResponse.json({ ok: true, durationMs, summary });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${ROUTE_LOG} error`, msg);
    return NextResponse.json(
      { ok: false, error: msg, durationMs: Date.now() - startedAt },
      { status: 500 }
    );
  }
}
