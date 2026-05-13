type JsonObject = Record<string, unknown>;

function getObj(value: unknown): JsonObject {
  if (value && typeof value === "object" && !Array.isArray(value)) return value as JsonObject;
  return {};
}

function getString(value: unknown): string | null {
  if (typeof value === "string") {
    const v = value.trim();
    return v ? v : null;
  }
  if (typeof value === "number") return String(value);
  return null;
}

function getNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const v = value.trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Bitrix ONVOXIMPLANTCALLEND nested payload (`data` / `DATA`). */
export function extractVoximplantDataPayload(raw_payload: unknown): JsonObject {
  const root = getObj(raw_payload);
  return getObj(root.data ?? root.DATA);
}

/** Seconds — несколько возможных ключей Bitrix (без подмены логики телефона). */
export function readCallDurationSecondsBestEffort(data: JsonObject): number | null {
  const keys = ["CALL_DURATION", "DURATION", "TOTAL_DURATION", "CALL_DURATION_FULL", "call_duration"];
  let best: number | null = null;
  for (const k of keys) {
    const n = getNumber(data[k]);
    if (n !== null && n > 0 && (best === null || n > best)) best = n;
  }
  return best;
}

function collectStatusTokens(data: JsonObject): string[] {
  const fields = [
    data.CALL_STATUS,
    data.call_status,
    data.STATUS,
    data.status,
    data.CALL_STATE,
    data.call_state,
    data.CALL_RESULT,
    data.RESULT,
    data.result
  ];
  const out: string[] = [];
  for (const f of fields) {
    const s = getString(f);
    if (s) out.push(s.replace(/\s+/g, "_").toUpperCase());
  }
  return out;
}

/**
 * Сначала явные «пропуск», затем успех — чтобы не принять NO_ANSWER за ANSWER.
 */
export function classifyInboundOutcomeFromStatusTokens(
  tokens: string[]
): "missed" | "success" | "unknown" {
  for (const u of tokens) {
    if (
      u.includes("NO_ANSWER") ||
      u.includes("NOANSWER") ||
      u.includes("UNANSWERED") ||
      u.includes("NOT_ANSWERED") ||
      (u.includes("MISSED") && !u.includes("NOT_MISSED"))
    ) {
      return "missed";
    }
    if (
      u.includes("BUSY") ||
      u.includes("REJECT") ||
      u.includes("DECLIN") ||
      u.includes("CANCEL") ||
      u.includes("FAILED") ||
      u.includes("LOST")
    ) {
      return "missed";
    }
  }

  for (const u of tokens) {
    if (
      u.includes("SUCCESS") ||
      u.includes("COMPLETE") ||
      u.includes("FINISHED") ||
      u.includes("CONNECTED") ||
      u.includes("ANSWERED") ||
      u.includes("ACCEPTED") ||
      u.includes("TALKING") ||
      u.includes("INCOME_SUCC") ||
      u.includes("SUCCESSFULL")
    ) {
      return "success";
    }
  }

  return "unknown";
}

/** Есть признаки что разговор состоялся / звонок успешно завершён как принятый. */
export function payloadIndicatesInboundCallWasAnsweredOrCompleted(data: JsonObject): boolean {
  const duration = readCallDurationSecondsBestEffort(data);
  if (duration !== null && duration > 0) return true;

  const tokens = collectStatusTokens(data);
  return classifyInboundOutcomeFromStatusTokens(tokens) === "success";
}

/** Явный пропуск по текстовым статусам (без CALL_FAILED_CODE). */
export function payloadIndicatesInboundCallDefinitelyMissedFromStatus(data: JsonObject): boolean {
  const tokens = collectStatusTokens(data);
  return classifyInboundOutcomeFromStatusTokens(tokens) === "missed";
}

/**
 * Строго: можно считать missed для alerting только при явном провале или статусе пропуска.
 */
export function isStrictlyMissedInboundPayload(data: JsonObject): boolean {
  if (payloadIndicatesInboundCallWasAnsweredOrCompleted(data)) return false;

  const failed = getString(data.CALL_FAILED_CODE);
  if (failed && failed !== "0") return true;

  if (payloadIndicatesInboundCallDefinitelyMissedFromStatus(data)) return true;

  return false;
}

/** Для строки call_events.status при записи из webhook. */
export function computeVoximplantStoredStatus(data: JsonObject): "missed" | "success" | "other" {
  const duration = readCallDurationSecondsBestEffort(data);
  if (duration !== null && duration > 0) return "success";

  const tokens = collectStatusTokens(data);
  const outcome = classifyInboundOutcomeFromStatusTokens(tokens);
  if (outcome === "success") return "success";
  if (outcome === "missed") return "missed";

  const failedCodeStr = getString(data.CALL_FAILED_CODE);
  if (failedCodeStr && failedCodeStr !== "0") return "missed";

  return "other";
}

export type MissedDiagSnapshot = {
  dbStatus: string;
  durationPayload: number | null;
  durationColumn: number | null;
  failedCodePayload: string | null;
  failedCodeColumn: string | null;
  callStatusTokens: string;
};

export function buildMissedDiagSnapshot(input: {
  status: string;
  call_duration_seconds?: number | null;
  failed_code?: string | null;
  raw_payload: unknown;
}): MissedDiagSnapshot {
  const data = extractVoximplantDataPayload(input.raw_payload);
  const tokens = collectStatusTokens(data);
  return {
    dbStatus: input.status,
    durationPayload: readCallDurationSecondsBestEffort(data),
    durationColumn:
      typeof input.call_duration_seconds === "number" && Number.isFinite(input.call_duration_seconds)
        ? input.call_duration_seconds
        : null,
    failedCodePayload: getString(data.CALL_FAILED_CODE),
    failedCodeColumn: input.failed_code?.trim() || null,
    callStatusTokens: tokens.slice(0, 12).join("|")
  };
}

/** Поля для case-debug / логов (без полного raw). */
export function voximplantPayloadSummary(raw_payload: unknown): Record<string, unknown> {
  const data = extractVoximplantDataPayload(raw_payload);
  return {
    CALL_TYPE: getString(data.CALL_TYPE),
    CALL_DURATION: data.CALL_DURATION ?? null,
    CALL_STATUS: getString(data.CALL_STATUS) ?? getString(data.STATUS),
    CALL_FAILED_CODE: getString(data.CALL_FAILED_CODE),
    CRM_ACTIVITY_ID: getString(data.CRM_ACTIVITY_ID) ?? getString(data.crm_activity_id),
    PORTAL_USER_ID: getString(data.PORTAL_USER_ID),
    USER_ID: getString(data.USER_ID) ?? getString(data.user_id)
  };
}
