const SECRET_KEY_LOWERS = new Set([
  "application_token",
  "access_token",
  "refresh_token",
  "client_secret"
]);

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEY_LOWERS.has(k);
}

/** Deep-clone JSON-like trees and mask known secret fields (debug / logs). */
export function redactSecretsForDebug(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map(redactSecretsForDebug);
  if (typeof value !== "object") return value;
  const o = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(o)) {
    if (isSecretKey(key)) {
      out[key] = "***";
    } else {
      out[key] = redactSecretsForDebug(v);
    }
  }
  return out;
}
