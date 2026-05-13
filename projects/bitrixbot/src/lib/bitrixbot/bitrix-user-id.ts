/** Нормализация Bitrix user id для сравнения и запросов в text-колонках. */
export function normalizeBitrixUserId(id: string | number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const s = String(id).trim();
  return s.length ? s : null;
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
