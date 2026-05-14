/** Нормализация Bitrix user id для сравнения и запросов в text-колонках. */
export function normalizeBitrixUserId(id: string | number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const s = String(id).trim();
  return s.length ? s : null;
}

/** False for null/empty and legacy `"0"` (must not create notification_deliveries recipients). */
export function isValidAlertRecipientBitrixUserId(id: string | number | null | undefined): boolean {
  const n = normalizeBitrixUserId(id);
  if (!n) return false;
  return n !== "0";
}

/** Варианты id для поиска (строка, число без ведущих нулей — на случай legacy). */
export function bitrixUserIdLookupCandidates(id: string | null): string[] {
  if (!id) return [];
  const trimmed = id.trim();
  if (!trimmed) return [];
  const out = new Set<string>();
  out.add(trimmed);
  const n = Number(trimmed);
  if (Number.isFinite(n) && String(Math.trunc(n)) === trimmed.replace(/^\+/, "")) {
    out.add(String(Math.trunc(n)));
  }
  return [...out];
}
