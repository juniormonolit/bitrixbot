import { NextResponse } from "next/server";
import { env } from "@/lib/env";

function isAuthorized(req: Request): boolean {
  const header = req.headers.get("x-debug-secret") ?? "";
  const url = new URL(req.url);
  const query = url.searchParams.get("secret") ?? "";
  const secret = header || query;
  return Boolean(secret && secret === env.DEBUG_SECRET);
}

/** Removed: runtime CRM activity resolution required Bitrix REST (`crm.activity.get`). Use local deals + deal_phone_index only. */
export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  return NextResponse.json(
    {
      ok: false,
      error: "disabled_webhook_first_architecture",
      hint:
        "Deal linkage is local-only (deals, deal_phone_index). Configure Bitrix robot/BP extended webhook or standard deal webhooks to populate the DB."
    },
    { status: 410 }
  );
}
