import { AsyncLocalStorage } from "node:async_hooks";
import { DEFAULT_MANAGERS_LIST_METHOD } from "@/lib/bitrix/managers-list-sync";

/**
 * Contexts where outbound Bitrix REST is permitted.
 * Everything else must use local DB only.
 */
export type BitrixRestContext = "daily_company_structure_sync" | "bitrix_message_delivery";

const store = new AsyncLocalStorage<BitrixRestContext>();

const SYNC_METHODS_BASE = ["user.get", "user.current", "user.fields", "department.get"] as const;

function buildSyncMethods(): Set<string> {
  const methods = new Set<string>(SYNC_METHODS_BASE);
  const loginsMethod = process.env.BITRIX_USER_LOGINS_REST_METHOD?.trim();
  if (loginsMethod) methods.add(loginsMethod);
  else methods.add(DEFAULT_MANAGERS_LIST_METHOD);
  return methods;
}
const DELIVERY_METHODS = new Set(["imbot.message.add", "im.notify.system.add"]);

export function getBitrixRestContext(): BitrixRestContext | undefined {
  return store.getStore();
}

export async function runWithBitrixRestContext<T>(
  ctx: BitrixRestContext,
  fn: () => Promise<T>
): Promise<T> {
  return store.run(ctx, fn);
}

/**
 * Enforced at HTTP layer for every Bitrix REST request.
 */
export function assertBitrixRestCallAllowed(method: string): void {
  const ctx = store.getStore();
  if (!ctx) {
    console.error("[CRITICAL] Bitrix REST denied: missing AsyncLocalStorage context", { method });
    throw new Error(`Bitrix REST is forbidden in runtime. Use local DB only. (method=${method})`);
  }

  if (ctx === "daily_company_structure_sync") {
    const syncMethods = buildSyncMethods();
    if (!syncMethods.has(method)) {
      console.error("[CRITICAL] Bitrix REST denied: method not allowed for company structure sync", {
        method
      });
      throw new Error(
        `Bitrix REST method "${method}" is not allowed in daily_company_structure_sync (allowed: ${[...syncMethods].join(", ")}).`
      );
    }
    return;
  }

  if (ctx === "bitrix_message_delivery") {
    if (!DELIVERY_METHODS.has(method)) {
      console.error("[CRITICAL] Bitrix REST denied: method not allowed for message delivery", {
        method
      });
      throw new Error(
        `Bitrix REST method "${method}" is not allowed in bitrix_message_delivery (allowed: ${[...DELIVERY_METHODS].join(", ")}).`
      );
    }
    return;
  }
}
