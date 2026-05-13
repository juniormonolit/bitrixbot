/** Ключи верхнего уровня JSON без утечки значений (диагностика). */
export function safeJsonTopKeys(value: unknown, max = 40): string[] {
  if (!value || typeof value !== "object") return [];
  const keys = Object.keys(value as Record<string, unknown>);
  return keys.slice(0, max);
}

export function safeNestedKeys(value: unknown, path: string[], max = 30): string[] {
  let cur: unknown = value;
  for (const p of path) {
    if (!cur || typeof cur !== "object") return [];
    cur = (cur as Record<string, unknown>)[p];
  }
  return safeJsonTopKeys(cur, max);
}
