import { NextResponse } from "next/server";
import { probeBitrixUserLoginField } from "@/lib/bitrix/probe-user-login";
import { isAlertingDebugRequestAuthorized } from "@/src/lib/bitrixbot/debug-request-secret";

const LOG = "[probe-user-login]";

/**
 * Проверка: отдаёт ли портал поле LOGIN через REST (user.fields + user.get).
 *
 * GET /api/debug/alerting/probe-user-login?secret=...&bitrixUserId=1&login=junior
 * Header: x-debug-secret
 */
export async function GET(req: Request) {
  if (!isAlertingDebugRequestAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const bitrixUserId = url.searchParams.get("bitrixUserId") ?? url.searchParams.get("userId") ?? "";
  const login = url.searchParams.get("login") ?? "";

  const startedAt = Date.now();
  console.log(`${LOG} start bitrixUserId=${bitrixUserId || "(none)"} login=${login || "(none)"}`);

  try {
    const probe = await probeBitrixUserLoginField({
      bitrixUserId: bitrixUserId || null,
      loginFilter: login || null
    });

    const durationMs = Date.now() - startedAt;
    console.log(`${LOG} done durationMs=${durationMs} conclusion=${probe.conclusion}`);

    return NextResponse.json({
      ok: true,
      durationMs,
      hint: "Стандартный user.get без LOGIN → нужен кастомный REST на портале (docs/bitrix-login-custom-rest.md). Смотрите probe.customRestMethod.",
      probe
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`${LOG} error message=${msg}`);
    return NextResponse.json(
      { ok: false, error: msg, durationMs: Date.now() - startedAt },
      { status: 500 }
    );
  }
}
