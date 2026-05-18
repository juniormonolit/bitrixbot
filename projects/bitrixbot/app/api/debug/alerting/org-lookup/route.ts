import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { bitrixUserIdLookupCandidates, normalizeBitrixUserId } from "@/lib/bitrixbot/bitrix-user-id";
import { debugComputeHierarchyForBitrixUser } from "@/lib/bitrixbot/resolve-org-hierarchy";

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

  const [{ data: empRows }, debug] = await Promise.all([
    supabase.from("employees").select("*").in("bitrix_user_id", candidates).limit(5),
    debugComputeHierarchyForBitrixUser(bitrixUserId)
  ]);

  const employeeRow = empRows?.[0] ?? null;

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

  const computed = debug.computed;
  const chain = computed?.resolved_path?.department_chain as
    | Array<{ id: string; bitrix_department_id: string; name: string }>
    | undefined;
  const dbg = computed?.resolved_path?.debug as
    | { department_chain_bitrix_ids?: string[]; resolved_rop?: string | null; resolved_department_director?: string | null }
    | undefined;

  return NextResponse.json({
    ok: true,
    bitrixUserId,
    lookupCandidates: candidates,
    foundInEmployees: Boolean(employeeRow),
    foundInHierarchy: Boolean(debug.hierarchyRowFromDb),
    employeeRow: employeeRow ?? null,
    hierarchyRow: debug.hierarchyRowFromDb,
    /** То же правило, что при rebuild (без записи в БД). */
    computedHierarchy: computed,
    departmentChain: chain ?? null,
    departmentChainBitrixIds: dbg?.department_chain_bitrix_ids ?? null,
    resolvedRop: dbg?.resolved_rop ?? computed?.rop_bitrix_user_id ?? null,
    resolvedDirector:
      dbg?.resolved_department_director ??
      computed?.department_director_bitrix_user_id ??
      computed?.company_director_bitrix_user_id ??
      null,
    sourceLoad: {
      employeesLoaded: debug.employeesLoaded,
      departmentsLoaded: debug.departmentsLoaded,
      overridesLoaded: debug.overridesLoaded
    },
    possibleMatches,
    tables: {
      employees: "public.employees (bitrix_user_id text)",
      hierarchy: "public.org_resolved_hierarchy (manager_bitrix_user_id text)"
    }
  });
}
