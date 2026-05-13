import { NextResponse } from "next/server";
import {
  fetchBitrixDepartments,
  fetchBitrixUsers,
  syncDepartments,
  syncEmployees
} from "@/lib/bitrix/org";

export async function POST() {
  const startedAt = Date.now();

  try {
    console.log("[bitrix-org-sync] start");

    const departments = await fetchBitrixDepartments();
    console.log("[bitrix-org-sync] fetched departments count", {
      count: departments.length
    });

    const { upserted: departmentsUpserted } = await syncDepartments();
    console.log("[bitrix-org-sync] synced departments count", {
      count: departmentsUpserted
    });

    const users = await fetchBitrixUsers();
    console.log("[bitrix-org-sync] fetched users count", { count: users.length });

    const { upserted: employeesUpserted, skipped } = await syncEmployees();
    console.log("[bitrix-org-sync] synced users count", { count: employeesUpserted });

    console.log("[bitrix-org-sync] done", {
      departmentsUpserted,
      employeesUpserted,
      durationMs: Date.now() - startedAt
    });

    return NextResponse.json({
      ok: true,
      departmentsUpserted,
      employeesUpserted,
      employeesSkipped: skipped
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

