import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { rebuildOrgResolvedHierarchy } from "@/src/lib/bitrixbot/resolve-org-hierarchy";

function isAuthorized(req: Request): boolean {
  const header = req.headers.get("x-debug-secret") ?? "";
  const url = new URL(req.url);
  const query = url.searchParams.get("secret") ?? "";
  const secret = header || query;
  return Boolean(secret) && secret === env.DEBUG_SECRET;
}

export async function POST(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startedAt = Date.now();
  const result = await rebuildOrgResolvedHierarchy();

  return NextResponse.json({
    ok: true,
    durationMs: Date.now() - startedAt,
    result
  });
}

