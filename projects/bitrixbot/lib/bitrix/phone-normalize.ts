/**
 * Canonical digits for matching call_events / missed_call_cases (RU-first).
 * Long digit runs (mis-parsed / concatenated) → prefer last 11 digits if they form 7XXXXXXXXXX.
 */
export function normalizePhoneForAnalytics(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/\D+/g, "");
  if (!digits) return null;

  if (digits.length >= 11) {
    const tail11 = digits.slice(-11);
    if (tail11.startsWith("7")) return tail11;
  }

  if (digits.length === 11 && digits.startsWith("8")) {
    return `7${digits.slice(1)}`;
  }

  if (digits.length === 10) {
    return `7${digits}`;
  }

  if (digits.length === 11 && digits.startsWith("7")) {
    return digits;
  }

  if (digits.length > 11) {
    const tail10 = digits.slice(-10);
    if (tail10.length === 10) return `7${tail10}`;
  }

  return digits;
}

/**
 * Human-friendly phone for chat templates (does not change DB keys).
 */
export function formatPhoneForDisplay(phoneNormalized: string | null | undefined): string {
  const raw = String(phoneNormalized ?? "").trim();
  if (!raw) return "";
  const canon = normalizePhoneForAnalytics(raw);
  if (!canon) return raw;

  if (canon.length === 11 && canon.startsWith("7")) {
    const a = canon.slice(1, 4);
    const b = canon.slice(4, 7);
    const c = canon.slice(7, 9);
    const d = canon.slice(9, 11);
    return `+7 (${a}) ${b}-${c}-${d}`;
  }

  return `+${canon.replace(/(\d{2})(?=\d)/g, "$1 ").trim()}`;
}
