import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import {
  getAlertingStatisticsDashboard,
  type AlertingStatisticsPeriodDays
} from "@/src/lib/bitrixbot/alerting-statistics-dashboard";

function isAuthorized(req: Request): boolean {
  const header = req.headers.get("x-debug-secret") ?? "";
  const url = new URL(req.url);
  const query = url.searchParams.get("secret") ?? "";
  const secret = header || query;
  return Boolean(secret && secret === env.DEBUG_SECRET);
}

function parsePeriod(raw: string | null): AlertingStatisticsPeriodDays {
  if (raw === "today" || raw === "1") return 1;
  if (raw === "30" || raw === "30d") return 30;
  return 7;
}

/** JSON для вкладки «Статистика» в админке alerting (только service + DEBUG_SECRET). */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const periodDays = parsePeriod(url.searchParams.get("period"));

  try {
    const dashboard = await getAlertingStatisticsDashboard({ periodDays });
    return NextResponse.json({ ok: true, dashboard });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ ok: false, error: msg }, { status: 500 });
  }
}
