export type RecipientRole =
  | "manager"
  | "rop"
  | "department_director"
  | "company_director";

const allowed: RecipientRole[] = [
  "manager",
  "rop",
  "department_director",
  "company_director"
];

export function parseRecipientRoles(input: unknown): RecipientRole[] {
  if (!input) return [];
  const raw = Array.isArray(input) ? input : [];
  const out: RecipientRole[] = [];

  for (const v of raw) {
    if (typeof v !== "string") continue;
    const key = v.trim() as RecipientRole;
    if (!key) continue;
    if (allowed.includes(key) && !out.includes(key)) out.push(key);
  }

  return out;
}

