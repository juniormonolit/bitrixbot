import { NextResponse } from "next/server";
import { sendSystemNotificationToUser } from "@/lib/bitrix/bot";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as null | {
    userId?: string;
  };

  const userId = body?.userId;
  if (!userId) {
    return NextResponse.json(
      { ok: false, error: "userId is required" },
      { status: 400 }
    );
  }

  await sendSystemNotificationToUser(userId, "Тестовое уведомление Bitrixbot");
  return NextResponse.json({ ok: true });
}

