import { bitrixCall } from "@/lib/bitrix/client";
import { runWithBitrixRestContext } from "@/lib/bitrix/bitrix-rest-context";
import { env } from "@/lib/env";

export type SendBitrixMessageInput = {
  bitrixUserId: string;
  messageText: string;
};

export type SendBitrixMessageResult = {
  ok: boolean;
  providerMessageId: string | null;
  rawResponse: unknown;
  errorMessage: string | null;
};

type BitrixImbotMessageAddResult = {
  messageId?: string | number;
  MESSAGE_ID?: string | number;
  id?: string | number;
  result?: unknown;
};

export async function sendBitrixMessage(
  input: SendBitrixMessageInput
): Promise<SendBitrixMessageResult> {
  const bitrixUserId = String(input.bitrixUserId ?? "").trim();
  const messageText = String(input.messageText ?? "").trim();

  if (!bitrixUserId) {
    return {
      ok: false,
      providerMessageId: null,
      rawResponse: null,
      errorMessage: "bitrixUserId is required"
    };
  }
  if (!messageText) {
    return {
      ok: false,
      providerMessageId: null,
      rawResponse: null,
      errorMessage: "messageText is required"
    };
  }

  try {
    const res = await runWithBitrixRestContext("bitrix_message_delivery", () =>
      bitrixCall<BitrixImbotMessageAddResult>("imbot.message.add", {
        BOT_ID: env.BITRIX_BOT_ID,
        CLIENT_ID: env.BITRIX_BOT_CLIENT_ID,
        DIALOG_ID: bitrixUserId,
        MESSAGE: messageText
      })
    );

    const providerMessageId =
      res?.messageId ?? res?.MESSAGE_ID ?? res?.id ?? null;

    return {
      ok: true,
      providerMessageId: providerMessageId !== null ? String(providerMessageId) : null,
      rawResponse: res,
      errorMessage: null
    };
  } catch (e) {
    return {
      ok: false,
      providerMessageId: null,
      rawResponse: null,
      errorMessage: e instanceof Error ? e.message : String(e)
    };
  }
}

