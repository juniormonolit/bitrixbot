import { bitrixCall } from "@/lib/bitrix/client";

export async function sendSystemNotificationToUser(
  userId: string,
  message: string
) {
  await bitrixCall("im.notify.system.add", {
    USER_ID: userId,
    MESSAGE: message
  });
}

