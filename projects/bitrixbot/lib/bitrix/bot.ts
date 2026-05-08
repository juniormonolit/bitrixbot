import { bitrixCall } from "@/lib/bitrix/client";
import { env } from "@/lib/env";

export async function sendSystemNotificationToUser(
  userId: string,
  message: string
) {
  await bitrixCall("im.notify.system.add", {
    USER_ID: userId,
    MESSAGE: message
  });
}

export async function sendBotMessageToUser(userId: string, message: string) {
  await bitrixCall("imbot.message.add", {
    BOT_ID: env.BITRIX_BOT_ID,
    CLIENT_ID: env.BITRIX_BOT_CLIENT_ID,
    DIALOG_ID: userId,
    MESSAGE: message
  });
}

