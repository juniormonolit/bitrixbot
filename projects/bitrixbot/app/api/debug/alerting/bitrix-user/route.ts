import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { normalizeBitrixUserId } from "@/src/lib/bitrixbot/bitrix-user-id";

function isAuthorized(req: Request): boolean {
  const header = req.headers.get("x-debug-secret") ?? "";
  const url = new URL(req.url);
  const query = url.searchParams.get("secret") ?? "";
  const secret = header || query;
  return Boolean(secret && secret === env.DEBUG_SECRET);
}

/** Diagnostics: read synced employee row only (no Bitrix `user.get`). */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const rawId = url.searchParams.get("bitrixUserId") ?? url.searchParams.get("userId") ?? "";
  const bitrixUserId = normalizeBitrixUserId(rawId);
  if (!bitrixUserId) {
    return NextResponse.json({ ok: false, error: "bitrixUserId required" }, { status: 400 });
  }

  const supabase = createServiceRoleClient();
  const { data: emp, error } = await supabase
    .from("employees")
    .select("bitrix_user_id, name, department_id")
    .eq("bitrix_user_id", bitrixUserId)
    .maybeSingle();

  if (error) {
    return NextResponse.json({ ok: false, error: error.message, bitrixUserId }, { status: 502 });
  }

  if (!emp) {
    return NextResponse.json({
      ok: true,
      bitrixUserId,
      existsInLocalEmployees: false,
      summary:
        "No row in public.employees for this Bitrix user id. Run daily company structure sync (04:00 MSK) or manual sync-org-full.",
      note: "Runtime alerting never calls Bitrix user.get — only this local cache."
    });
  }

  const typed = emp as { bitrix_user_id: string; name: string | null; department_id: string | null };

  return NextResponse.json({
    ok: true,
    bitrixUserId,
    existsInLocalEmployees: true,
    displayName: typed.name ?? typed.bitrix_user_id,
    departmentIdUuid: typed.department_id,
    note:
      "Row from public.employees (filled by company structure sync). Runtime alerting does not call Bitrix user.get."
  });
}
