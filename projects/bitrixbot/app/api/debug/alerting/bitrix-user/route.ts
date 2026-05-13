import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { bitrixCall } from "@/lib/bitrix/client";
import { normalizeBitrixUserId } from "@/src/lib/bitrixbot/bitrix-user-id";

function isAuthorized(req: Request): boolean {
  const header = req.headers.get("x-debug-secret") ?? "";
  const url = new URL(req.url);
  const query = url.searchParams.get("secret") ?? "";
  const secret = header || query;
  return Boolean(secret && secret === env.DEBUG_SECRET);
}

type BitrixUserRecord = Record<string, unknown>;

function asBoolish(v: unknown): boolean | null {
  if (v === true || v === "Y" || v === "y" || v === 1 || v === "1") return true;
  if (v === false || v === "N" || v === "n" || v === 0 || v === "0") return false;
  return null;
}

function normalizeDeptIds(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map((x) => String(x)).filter(Boolean);
  return [String(v)].filter(Boolean);
}

function displayName(u: BitrixUserRecord): string {
  const parts = [u.NAME, u.LAST_NAME, u.SECOND_NAME].map((x) => (typeof x === "string" ? x.trim() : ""));
  const joined = parts.filter(Boolean).join(" ").trim();
  return joined || String(u.ID ?? "");
}

/** Bitrix `user.get` for a single portal user id (diagnostics). */
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

  try {
    const rows = await bitrixCall<BitrixUserRecord[]>("user.get", {
      filter: { ID: bitrixUserId },
      select: [
        "ID",
        "ACTIVE",
        "NAME",
        "LAST_NAME",
        "SECOND_NAME",
        "LOGIN",
        "EMAIL",
        "WORK_POSITION",
        "WORK_DEPARTMENT",
        "UF_DEPARTMENT",
        "USER_TYPE",
        "LAST_ACTIVITY_DATE"
      ]
    });

    const list = Array.isArray(rows) ? rows : [];
    const user = list[0] ?? null;

    if (!user) {
      return NextResponse.json({
        ok: true,
        bitrixUserId,
        existsInBitrix: false,
        summary: "No user returned by user.get for this ID (wrong portal, deleted user, or invalid id).",
        rawResultCount: list.length
      });
    }

    const active = asBoolish(user.ACTIVE);
    const ufDept = normalizeDeptIds(user.UF_DEPARTMENT);
    const workDept =
      typeof user.WORK_DEPARTMENT === "string"
        ? user.WORK_DEPARTMENT.trim()
        : user.WORK_DEPARTMENT != null
          ? String(user.WORK_DEPARTMENT)
          : "";

    let inactiveHint: string | null = null;
    if (active === false) {
      inactiveHint =
        "Bitrix user exists but ACTIVE is false — typically dismissed, blocked, or deactivated; such users are often excluded from org sync (e.g. filter ACTIVE=true).";
    } else if (active === true) {
      inactiveHint = null;
    } else {
      inactiveHint = "ACTIVE field missing or unexpected shape; inspect raw user object.";
    }

    return NextResponse.json({
      ok: true,
      bitrixUserId,
      existsInBitrix: true,
      active,
      activeInterpretation:
        active === true ? "active" : active === false ? "inactive_or_blocked" : "unknown",
      inactiveHint,
      displayName: displayName(user),
      login: user.LOGIN ?? null,
      email: user.EMAIL ?? null,
      workPosition: user.WORK_POSITION ?? null,
      workDepartment: workDept || null,
      ufDepartmentIds: ufDept,
      userType: user.USER_TYPE ?? null,
      lastActivityDate: user.LAST_ACTIVITY_DATE ?? null,
      rawUser: user,
      note:
        "Compare with public.employees: sync jobs often import only ACTIVE users; call_events may still reference old or technical Bitrix user ids."
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg, bitrixUserId }, { status: 502 });
  }
}
