/**
 * Bitrix user profile department fields → list of Bitrix department ids (strings).
 * UF_DEPARTMENT is the canonical org link; WORK_DEPARTMENT is used only when it yields numeric id(s).
 */

/** Normalize UF_DEPARTMENT / similar: number[], string[], string, null → string[]. */
export function normalizeDepartmentIdList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  const s = String(v).trim();
  return s ? [s] : [];
}

/**
 * When WORK_DEPARTMENT carries Bitrix department id(s), not a free-text title.
 * Accepts: number, numeric string, numeric[], comma/semicolon-separated numeric list.
 */
export function extractWorkDepartmentIdsAsBitrix(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) {
    return v
      .map((x) => String(x).trim())
      .filter((s) => /^\d+$/.test(s));
  }
  if (typeof v === "number" && Number.isFinite(v)) {
    return [String(Math.trunc(v))];
  }
  if (typeof v === "string") {
    const t = v.trim();
    if (!t) return [];
    if (/^\d+$/.test(t)) return [t];
    const parts = t.split(/[,;]/).map((s) => s.trim()).filter(Boolean);
    if (parts.length && parts.every((p) => /^\d+$/.test(p))) return parts;
    return [];
  }
  return [];
}

/**
 * Prefer UF_DEPARTMENT for org structure; if empty, use WORK_DEPARTMENT only when it parses as id list.
 */
export function resolveBitrixUserDepartmentIds(
  ufDepartment: unknown,
  workDepartment: unknown
): string[] {
  const fromUf = normalizeDepartmentIdList(ufDepartment);
  if (fromUf.length > 0) return fromUf;
  return extractWorkDepartmentIdsAsBitrix(workDepartment);
}
