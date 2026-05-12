import { env } from "@/lib/env";

/** x-debug-secret header or ?secret= query; value must match env.DEBUG_SECRET. */
export function isAlertingDebugRequestAuthorized(req: Request): boolean {
  const header = req.headers.get("x-debug-secret") ?? "";
  const url = new URL(req.url);
  const query = url.searchParams.get("secret") ?? "";
  const secret = header || query;
  return Boolean(secret && secret === env.DEBUG_SECRET);
}
