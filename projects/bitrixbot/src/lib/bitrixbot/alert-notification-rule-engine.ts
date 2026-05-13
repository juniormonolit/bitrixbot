import type { RecipientRole } from "@/src/lib/bitrixbot/recipient-roles";

export type AlertRecipientType = "responsible_manager" | "rop" | "director" | "manual_user_id";

export type AlertRecipientSpec =
  | { type: "responsible_manager" }
  | { type: "rop" }
  | { type: "director" }
  | { type: "manual_user_id"; userId: string };

export type AlertNotificationRuleRow = {
  id: string;
  name: string;
  enabled: boolean;
  sort_order: number;
  missed_count_threshold: number | null;
  no_callback_minutes: number | null;
  condition_operator: "AND" | "OR";
  recipients: unknown;
  message_template: string;
};

export type AlertRuleEvaluationContext = {
  missedCount: number;
  minutesSinceLastMissed: number | null;
  hasCallbackAfterMissed: boolean;
};

export type ResolvedRecipient = {
  recipient_role: RecipientRole | "manual";
  bitrix_user_id: string;
  name: string | null;
  recipient_source: string | null;
};

function parseRecipientEntry(v: unknown): AlertRecipientSpec | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const t = o.type;
  if (t === "responsible_manager") return { type: "responsible_manager" };
  if (t === "rop") return { type: "rop" };
  if (t === "director") return { type: "director" };
  if (t === "manual_user_id") {
    const uid = String(o.userId ?? o.user_id ?? "").trim();
    if (!uid) return null;
    return { type: "manual_user_id", userId: uid };
  }
  return null;
}

export function parseAlertRecipientSpecs(recipients: unknown): AlertRecipientSpec[] {
  if (!Array.isArray(recipients)) return [];
  const out: AlertRecipientSpec[] = [];
  for (const v of recipients) {
    const p = parseRecipientEntry(v);
    if (p) out.push(p);
  }
  return out;
}

function missedPart(
  threshold: number | null,
  missedCount: number
): boolean | null {
  if (threshold === null) return null;
  return missedCount >= threshold;
}

function minutesPart(
  noCallbackMinutes: number | null,
  ctx: AlertRuleEvaluationContext
): boolean | null {
  if (noCallbackMinutes === null) return null;
  if (ctx.hasCallbackAfterMissed) return false;
  if (ctx.minutesSinceLastMissed === null) return false;
  return ctx.minutesSinceLastMissed >= noCallbackMinutes;
}

/**
 * Rule matches if configured parts are satisfied, combined with AND/OR.
 * If only one side is configured, operator is ignored.
 */
export function evaluateAlertRuleCondition(
  rule: Pick<
    AlertNotificationRuleRow,
    "missed_count_threshold" | "no_callback_minutes" | "condition_operator"
  >,
  ctx: AlertRuleEvaluationContext
): boolean {
  const a = missedPart(rule.missed_count_threshold, ctx.missedCount);
  const b = minutesPart(rule.no_callback_minutes, ctx);

  if (a === null && b === null) return false;
  if (a === null && b !== null) return b;
  if (b === null && a !== null) return a;

  if (rule.condition_operator === "AND") {
    return Boolean(a && b);
  }
  return Boolean(a || b);
}

type HierarchyForResolve = {
  rop_bitrix_user_id: string | null;
  rop_name: string | null;
  department_director_bitrix_user_id: string | null;
  department_director_name: string | null;
  company_director_bitrix_user_id: string | null;
  company_director_name: string | null;
} | null;

export function resolveAlertRecipients(
  specs: AlertRecipientSpec[],
  input: {
    managerBitrixUserId: string | null;
    managerName: string | null;
    treatManagerFallback: boolean;
    hierarchy: HierarchyForResolve;
  },
  onUnresolved: (msg: string) => void
): ResolvedRecipient[] {
  const out: ResolvedRecipient[] = [];
  const seen = new Set<string>();

  for (const spec of specs) {
    if (spec.type === "responsible_manager") {
      const uid = input.managerBitrixUserId?.trim() ?? "";
      if (!uid) {
        onUnresolved("recipient_not_resolved:type=responsible_manager reason=no_manager_bitrix_user_id");
        continue;
      }
      const key = `manager:${uid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      let name = input.managerName?.trim() || null;
      let recipient_source: string | null = null;
      if (input.treatManagerFallback && !name) {
        name = `manager (${uid})`;
        recipient_source = "call_event_manager_bitrix_user_id_fallback";
      }
      out.push({
        recipient_role: "manager",
        bitrix_user_id: uid,
        name,
        recipient_source
      });
      continue;
    }

    if (spec.type === "rop") {
      const uid = input.hierarchy?.rop_bitrix_user_id?.trim() ?? "";
      if (!uid) {
        onUnresolved("recipient_not_resolved:type=rop reason=no_rop_in_hierarchy");
        continue;
      }
      const key = `rop:${uid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        recipient_role: "rop",
        bitrix_user_id: uid,
        name: input.hierarchy?.rop_name?.trim() || null,
        recipient_source: null
      });
      continue;
    }

    if (spec.type === "director") {
      const deptId = input.hierarchy?.department_director_bitrix_user_id?.trim() ?? "";
      const compId = input.hierarchy?.company_director_bitrix_user_id?.trim() ?? "";
      const uid = deptId || compId;
      if (!uid) {
        onUnresolved("recipient_not_resolved:type=director reason=no_department_or_company_director");
        continue;
      }
      const role: RecipientRole = deptId ? "department_director" : "company_director";
      const name = deptId
        ? input.hierarchy?.department_director_name?.trim() || null
        : input.hierarchy?.company_director_name?.trim() || null;
      const key = `${role}:${uid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        recipient_role: role,
        bitrix_user_id: uid,
        name,
        recipient_source: null
      });
      continue;
    }

    if (spec.type === "manual_user_id") {
      const uid = spec.userId.trim();
      if (!uid) {
        onUnresolved("recipient_not_resolved:type=manual_user_id reason=empty_user_id");
        continue;
      }
      const key = `manual:${uid}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        recipient_role: "manual",
        bitrix_user_id: uid,
        name: null,
        recipient_source: "alert_rule_manual_user_id"
      });
    }
  }

  return out;
}

export function defaultMessageLineForRecipientRole(role: RecipientRole | "manual"): string {
  if (role === "manager") return "СРОЧНО ПЕРЕЗВОНИ КЛИЕНТУ. ДО ТЕБЯ НЕ ДОЗВОНИЛИСЬ.";
  if (role === "rop") return "КЛИЕНТ НЕ ДОЗВОНИЛСЯ ДО МЕНЕДЖЕРА.";
  if (role === "department_director") return "ЭСКАЛАЦИЯ: ЕСТЬ ПОВТОРНЫЕ ПРОПУЩЕННЫЕ ЗВОНКИ.";
  if (role === "company_director") return "ЭСКАЛАЦИЯ НА УРОВЕНЬ КОМПАНИИ: КЛИЕНТ НЕ МОЖЕТ ДОЗВОНИТЬСЯ.";
  return "УВЕДОМЛЕНИЕ ПО ПРАВИЛУ ALERTING.";
}
