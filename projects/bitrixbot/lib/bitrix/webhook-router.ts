type WebhookCategory = "call" | "other";

export type BitrixWebhookRouteResult = {
  category: WebhookCategory;
  eventName: string | null;
};

function getString(obj: Record<string, unknown>, key: string): string | null {
  const v = obj[key];
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return null;
}

export function detectBitrixEventName(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const obj = payload as Record<string, unknown>;
  return getString(obj, "event") ?? getString(obj, "EVENT");
}

export function routeBitrixWebhook(payload: unknown): BitrixWebhookRouteResult {
  const eventName = detectBitrixEventName(payload);
  const normalized = (eventName ?? "").toLowerCase();

  const isCall =
    normalized.includes("call") ||
    normalized.includes("telephony") ||
    normalized.includes("voximplant");

  return {
    category: isCall ? "call" : "other",
    eventName
  };
}

