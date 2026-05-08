import { NextResponse } from "next/server";
import { syncDepartments, syncEmployees } from "../../../../../lib/bitrix/org";

export async function POST() {
  const startedAt = Date.now();

  try {
    console.log("[bitrix-org-sync] start");

    const { upserted: departmentsUpserted } = await syncDepartments();
    const { upserted: employeesUpserted } = await syncEmployees();

    console.log("[bitrix-org-sync] done", {
      departmentsUpserted,
      employeesUpserted,
      durationMs: Date.now() - startedAt
    });

    return NextResponse.json({
      ok: true,
      departmentsUpserted,
      employeesUpserted
    });
  } catch (e) {
    console.log("[bitrix-org-sync] error", {
      message: e instanceof Error ? e.message : String(e),
      durationMs: Date.now() - startedAt
    });

    return NextResponse.json(
      {
        ok: false,
        error: e instanceof Error ? e.message : String(e)
      },
      { status: 500 }
    );
  }
}

