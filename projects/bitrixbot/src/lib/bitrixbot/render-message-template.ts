export type MessageTemplateValues = {
  message?: string | null;
  manager_name?: string | null;
  deal_id?: string | number | null;
  deal_title?: string | null;
  deal_url?: string | null;
  contact_name?: string | null;
  phone?: string | null;
  missed_count?: string | number | null;
  missed_at?: string | null;
  case_id?: string | null;
  main_recipient?: string | null;
  minutes_without_callback?: string | number | null;
  recipient_role?: string | null;
  recipient_name?: string | null;
};

function normalizeTemplateValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** Turn stored `\n` escape sequences into real newlines before rendering. */
export function normalizeTemplateNewlines(body: string | null | undefined): string {
  if (!body) return "";
  return body.replace(/\\n/g, "\n");
}

export function renderMessageTemplate(
  body: string | null | undefined,
  values: MessageTemplateValues
): string {
  if (!body) return "";

  const normalizedBody = normalizeTemplateNewlines(body);

  const map: Record<string, string> = {
    message: normalizeTemplateValue(values.message),
    manager_name: normalizeTemplateValue(values.manager_name),
    deal_id: normalizeTemplateValue(values.deal_id),
    deal_title: normalizeTemplateValue(values.deal_title),
    deal_url: normalizeTemplateValue(values.deal_url),
    contact_name: normalizeTemplateValue(values.contact_name),
    phone: normalizeTemplateValue(values.phone),
    missed_count: normalizeTemplateValue(values.missed_count),
    missed_at: normalizeTemplateValue(values.missed_at),
    case_id: normalizeTemplateValue(values.case_id),
    main_recipient: normalizeTemplateValue(values.main_recipient),
    minutes_without_callback: normalizeTemplateValue(values.minutes_without_callback),
    recipient_role: normalizeTemplateValue(values.recipient_role),
    recipient_name: normalizeTemplateValue(values.recipient_name)
  };

  let rendered = normalizedBody.replace(/\{\{([a-z_]+)\}\}/gi, (_, keyRaw: string) => {
    const key = keyRaw.toLowerCase();
    return map[key] ?? "";
  });

  rendered = rendered.replace(/\{([a-z_]+)\}/gi, (_, keyRaw: string) => {
    const key = keyRaw.toLowerCase();
    return map[key] ?? "";
  });

  return rendered
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
