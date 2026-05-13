import { NextResponse } from "next/server";
import { env } from "@/lib/env";
import { getAlertingSettings } from "@/src/lib/bitrixbot/get-alerting-settings";
import { syncOrgStructureFromBitrixAndRebuild } from "@/src/lib/bitrixbot/sync-org-structure-from-bitrix";

/**
 * Ежедневное автообновление структуры (Vercel Cron → см. vercel.json).
 * Аутентификация: Authorization: Bearer &lt;CRON_SECRET&gt; или x-debug-secret / DEBUG_SECRET.
 *
 * TODO: сопоставить org_structure_auto_refresh_time_local с часовым поясом деплоя;
 * сейчас расписание cron задаётся в UTC в vercel.json (по умолчанию 04:00 UTC).
 */
function isCronAuthorized(req: Request): boolean {
  const bearer = req.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && bearer === `Bearer ${cronSecret}`) return true;
  const hdr = req.headers.get("x-debug-secret") ?? "";
  return Boolean(hdr && hdr === env.DEBUG_SECRET);
}

export async function GET(req: Request) {
  if (!isCronAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const settings = await getAlertingSettings();
  if (!settings.org_structure_auto_refresh_enabled) {
    return NextResponse.json({
      ok: true,
      skipped: true,
      reason: "org_structure_auto_refresh_enabled=false"
    });
  }

  const startedAt = Date.now();
  try {
    const result = await syncOrgStructureFromBitrixAndRebuild();
    return NextResponse.json({
      ok: true,
      durationMs: Date.now() - startedAt,
      result
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json(
      { ok: false, error: msg, durationMs: Date.now() - startedAt },
      { status: 500 }
    );
  }
}
