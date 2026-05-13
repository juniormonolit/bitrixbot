import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { bitrixUserIdLookupCandidates, normalizeBitrixUserId } from "@/src/lib/bitrixbot/bitrix-user-id";

function isAuthorized(req: Request): boolean {
  const header = req.headers.get("x-debug-secret") ?? "";
  const url = new URL(req.url);
  const query = url.searchParams.get("secret") ?? "";
  const secret = header || query;
  return Boolean(secret && secret === env.DEBUG_SECRET);
}

/** Только цифры для широкого поиска «похожих» id (осторожно, limit). */
function digitsOnly(s: string): string {
  return s.replace(/\D/g, "").slice(0, 15);
}

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
  const candidates = bitrixUserIdLookupCandidates(bitrixUserId);

  const [{ data: empRows }, { data: hierRows }] = await Promise.all([
    supabase.from("employees").select("*").in("bitrix_user_id", candidates).limit(5),
    supabase
      .from("org_resolved_hierarchy")
      .select("*")
      .in("manager_bitrix_user_id", candidates)
      .limit(5)
  ]);

  const employeeRow = empRows?.[0] ?? null;
  const hierarchyRow = hierRows?.[0] ?? null;

  let possibleMatches: unknown[] = [];
  if (!employeeRow) {
    const d = digitsOnly(bitrixUserId);
    if (d.length >= 3) {
      const { data: loose } = await supabase
        .from("employees")
        .select("bitrix_user_id, name, department_id")
        .ilike("bitrix_user_id", `%${d}%`)
        .limit(15);
      possibleMatches = loose ?? [];
    }
  }

  return NextResponse.json({
    ok: true,
    bitrixUserId,
    lookupCandidates: candidates,
    foundInEmployees: Boolean(employeeRow),
    foundInHierarchy: Boolean(hierarchyRow),
    employeeRow: employeeRow ?? null,
    hierarchyRow: hierarchyRow ?? null,
    possibleMatches,
    tables: {
      employees: "public.employees (bitrix_user_id text)",
      hierarchy: "public.org_resolved_hierarchy (manager_bitrix_user_id text)"
    }
  });
}
