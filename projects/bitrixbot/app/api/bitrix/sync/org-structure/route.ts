import { NextResponse } from "next/server";
import { syncDepartments, syncEmployees } from "@/lib/bitrix/org";

export async function POST() {
  const startedAt = Date.now();

  try {
    console.log("[bitrix-org-sync] start");

    const {
      upserted: departmentsUpserted,
      departmentsFetchedTotal,
      departmentsPagesFetched
    } = await syncDepartments();
    console.log("[bitrix-org-sync] synced departments", {
      departmentsUpserted,
      departmentsFetchedTotal,
      departmentsPagesFetched
    });

    const {
      upserted: employeesUpserted,
      skipped: employeesSkipped,
      usersFetchedTotal,
      usersPagesFetched
    } = await syncEmployees();
    console.log("[bitrix-org-sync] synced employees", {
      employeesUpserted,
      employeesSkipped,
      usersFetchedTotal,
      usersPagesFetched
    });

    console.log("[bitrix-org-sync] done", {
      departmentsUpserted,
      departmentsFetchedTotal,
      departmentsPagesFetched,
      employeesUpserted,
      employeesSkipped,
      usersFetchedTotal,
      usersPagesFetched,
      durationMs: Date.now() - startedAt
    });

    return NextResponse.json({
      ok: true,
      departmentsUpserted,
      departmentsFetchedTotal,
      departmentsPagesFetched,
      employeesUpserted,
      employeesSkipped,
      usersFetchedTotal,
      usersPagesFetched
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
