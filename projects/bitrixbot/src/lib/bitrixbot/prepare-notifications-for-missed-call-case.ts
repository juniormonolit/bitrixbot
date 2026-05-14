import { createServiceRoleClient } from "@/lib/supabase/server";
import { withTimeout } from "@/src/lib/bitrixbot/async-timeout";
import {
  AlertNotificationRuleRow,
  defaultMessageLineForRecipientRole,
  evaluateAlertRuleConditionDetailed,
  parseAlertRecipientSpecs,
  resolveAlertRecipients,
  type AlertRuleEvaluationContext
} from "@/src/lib/bitrixbot/alert-notification-rule-engine";
import { formatPhoneForDisplay } from "@/lib/bitrix/phone-normalize";
import { dealUrlForMessageTemplate } from "@/src/lib/bitrixbot/deal-enrichment-from-activity";
import { normalizeBitrixUserId } from "@/src/lib/bitrixbot/bitrix-user-id";
import { renderMessageTemplate } from "@/src/lib/bitrixbot/render-message-template";
import { outboundActivityBlocksMissedPrepare } from "@/src/lib/bitrixbot/alerting-prepare-outbound-guard";

const LOG = "[alerting:prepare-notifications]";
const DB_OP_MS = 2_500;
const DELIVERY_INSERT_TIMEOUT_MS = 6_000;
const RULES_PAGE = 500;

/** Unique index from migration `notification_deliveries_alert_rule_recipient_dedupe_idx`. */
const NOTIFICATION_DELIVERIES_ALERT_RULE_RECIPIENT_DEDUPE_MARKER =
  "notification_deliveries_alert_rule_recipient_dedupe";

function isAlertRuleRecipientDedupeViolation(err: {
  code?: string;
  message?: string;
  details?: string | null;
} | null): boolean {
  if (!err || err.code !== "23505") return false;
  const blob = `${err.message ?? ""} ${err.details ?? ""}`;
  return blob.includes(NOTIFICATION_DELIVERIES_ALERT_RULE_RECIPIENT_DEDUPE_MARKER);
}

export type PrepareNotificationsDiag = { lastStage: string };

export type PrepareNotificationsOptions = {
  treatManagerAsEmployeeFallback?: boolean;
  /** When true, result includes `ruleEvaluationDebug` (per-rule predicates and delivery stats). */
  includeRuleEvaluationDebug?: boolean;
};

/** One row per configured alert_notification_rule — for diagnosing matches without reading logs. */
export type PrepareRuleEvaluationSnapshot = {
  ruleId: string;
  ruleName: string;
  logic: "AND" | "OR";
  missedCountConditionMet: boolean | null;
  timeWithoutCallbackConditionMet: boolean | null;
  finalMatched: boolean;
  recipientsResolved: number;
  deliveryCreated: number;
  skippedExistingDeliveries: number;
};

type MissedCallCaseRow = {
  id: string;
  status: string;
  phone_normalized: string;
  deal_id: number | null;
  deal_url: string | null;
  deal_title: string | null;
  contact_name: string | null;
  manager_bitrix_user_id: string | null;
  manager_name: string | null;
  department_id: string | null;
  missed_count: number;
  last_missed_at: string;
  last_outbound_at: string | null;
  last_successful_callback_at: string | null;
  context: unknown;
};

type ResolvedHierarchyRow = {
  manager_bitrix_user_id: string;
  rop_bitrix_user_id: string | null;
  rop_name: string | null;
  department_director_bitrix_user_id: string | null;
  department_director_name: string | null;
  company_director_bitrix_user_id: string | null;
  company_director_name: string | null;
};

type DeliveryStatus = "pending" | "sent" | "failed" | "skipped";

export type PrepareNotificationsResult = {
  caseId: string;
  /** Last alert rule id that matched conditions in this run (by sort_order). */
  selectedRuleId: string | null;
  createdDeliveriesCount: number;
  /** Existing pending/sent row or dedupe unique hit for case+rule+recipient (not an error). */
  skippedExistingDeliveries: number;
  skippedRecipients: { role: string; reason: string }[];
  warnings: string[];
  managerRecipientFallbackUsed: boolean;
  ruleEvaluationDebug?: PrepareRuleEvaluationSnapshot[];
};

function mark(diag: PrepareNotificationsDiag | null | undefined, stage: string, meta?: Record<string, unknown>) {
  if (diag) diag.lastStage = stage;
  console.log(`${LOG} stage`, { stage, ...meta });
}

function minutesBetween(now: Date, iso: string): number | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  const diffMs = now.getTime() - t;
  if (!Number.isFinite(diffMs)) return null;
  return Math.floor(diffMs / 60000);
}

function hasCallbackAfterMissed(caseRow: MissedCallCaseRow): boolean {
  const lastMissed = new Date(caseRow.last_missed_at).getTime();
  if (!Number.isFinite(lastMissed)) return false;

  const lastOutbound = caseRow.last_outbound_at ? new Date(caseRow.last_outbound_at).getTime() : NaN;
  if (Number.isFinite(lastOutbound) && lastOutbound >= lastMissed) return true;

  const lastCb = caseRow.last_successful_callback_at
    ? new Date(caseRow.last_successful_callback_at).getTime()
    : NaN;
  if (Number.isFinite(lastCb) && lastCb >= lastMissed) return true;

  return false;
}

async function alreadyDeliveredOrPending(
  supabase: ReturnType<typeof createServiceRoleClient>,
  input: { case_id: string; alert_rule_id: string; recipient_bitrix_user_id: string }
): Promise<boolean> {
  const { data, error } = await withTimeout(
    supabase
      .from("notification_deliveries")
      .select("id, delivery_status")
      .eq("case_id", input.case_id)
      .eq("alert_rule_id", input.alert_rule_id)
      .eq("recipient_bitrix_user_id", input.recipient_bitrix_user_id)
      .in("delivery_status", ["pending", "sent"])
      .limit(1),
    DB_OP_MS,
    "alreadyDeliveredOrPending"
  );
  if (error) throw new Error(error.message);
  return Boolean(data && data.length > 0);
}

async function loadAlertNotificationRules(
  supabase: ReturnType<typeof createServiceRoleClient>
): Promise<AlertNotificationRuleRow[]> {
  const all: AlertNotificationRuleRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await withTimeout(
      supabase
        .from("alert_notification_rules")
        .select(
          "id, name, enabled, sort_order, missed_count_threshold, no_callback_minutes, condition_operator, recipients, message_template"
        )
        .eq("enabled", true)
        .order("sort_order", { ascending: true })
        .range(from, from + RULES_PAGE - 1),
      DB_OP_MS,
      "alert_notification_rules.select"
    );
    if (error) throw new Error(error.message);
    const chunk = (data ?? []) as AlertNotificationRuleRow[];
    if (chunk.length === 0) break;
    all.push(...chunk);
    from += chunk.length;
  }
  return all;
}

export async function prepareNotificationsForMissedCallCase(
  caseId: string,
  diag?: PrepareNotificationsDiag | null,
  options?: PrepareNotificationsOptions
): Promise<PrepareNotificationsResult> {
  const supabase = createServiceRoleClient();
  const warnings: string[] = [];
  const skippedRecipients: { role: string; reason: string }[] = [];
  let managerRecipientFallbackUsed = false;
  let skippedExistingDeliveries = 0;
  const treatFb = Boolean(options?.treatManagerAsEmployeeFallback);
  const wantRuleDebug = Boolean(options?.includeRuleEvaluationDebug);
  const ruleEvaluationDebug: PrepareRuleEvaluationSnapshot[] | undefined = wantRuleDebug ? [] : undefined;

  mark(diag, "prepare_notifications_start", { caseId });
  mark(diag, "prepare_notifications_lookup_case_start", { caseId });
  const { data: caseRow, error: caseErr } = await withTimeout(
    supabase
      .from("missed_call_cases")
      .select(
        "id, status, phone_normalized, deal_id, deal_url, deal_title, contact_name, manager_bitrix_user_id, manager_name, department_id, missed_count, last_missed_at, last_outbound_at, last_successful_callback_at, context"
      )
      .eq("id", caseId)
      .maybeSingle(),
    DB_OP_MS,
    "missed_call_cases.select"
  );
  mark(diag, "prepare_notifications_lookup_case_done", { caseId, found: Boolean(caseRow) });
  if (caseErr) throw new Error(caseErr.message);
  if (!caseRow) {
    return {
      caseId,
      selectedRuleId: null,
      createdDeliveriesCount: 0,
      skippedExistingDeliveries: 0,
      skippedRecipients: [],
      warnings: ["case_not_found"],
      managerRecipientFallbackUsed: false,
      ...(wantRuleDebug ? { ruleEvaluationDebug: [] } : {})
    };
  }

  const typedCase = caseRow as MissedCallCaseRow;

  const caseStatus = String(typedCase.status ?? "").trim();
  if (caseStatus !== "open") {
    warnings.push("prepare_skipped_case_not_open");
    console.log(`${LOG} skipped_case_not_open`, { caseId: typedCase.id, status: typedCase.status });
    return {
      caseId: typedCase.id,
      selectedRuleId: null,
      createdDeliveriesCount: 0,
      skippedExistingDeliveries: 0,
      skippedRecipients: [],
      warnings,
      managerRecipientFallbackUsed: false,
      ...(wantRuleDebug ? { ruleEvaluationDebug: [] } : {})
    };
  }

  const caseManagerId = normalizeBitrixUserId(typedCase.manager_bitrix_user_id);
  if (!caseManagerId) {
    warnings.push("prepare_skipped_missing_case_manager");
    console.log(`${LOG} skipped_no_case_manager`, { caseId });
    return {
      caseId: typedCase.id,
      selectedRuleId: null,
      createdDeliveriesCount: 0,
      skippedExistingDeliveries: 0,
      skippedRecipients: [],
      warnings,
      managerRecipientFallbackUsed: false,
      ...(wantRuleDebug ? { ruleEvaluationDebug: [] } : {})
    };
  }

  const outboundPrepareBlock = await outboundActivityBlocksMissedPrepare(supabase, {
    phone_normalized: typedCase.phone_normalized,
    context: typedCase.context
  });
  if (outboundPrepareBlock) {
    warnings.push(`prepare_blocked_${outboundPrepareBlock}`);
    console.log(`${LOG} blocked_outbound_prepare`, {
      caseId,
      reason: outboundPrepareBlock,
      phone_normalized: typedCase.phone_normalized
    });
    return {
      caseId: typedCase.id,
      selectedRuleId: null,
      createdDeliveriesCount: 0,
      skippedExistingDeliveries: 0,
      skippedRecipients,
      warnings,
      managerRecipientFallbackUsed: false,
      ...(wantRuleDebug ? { ruleEvaluationDebug: [] } : {})
    };
  }

  if (hasCallbackAfterMissed(typedCase)) {
    warnings.push("prepare_skipped_followup_after_last_missed");
    console.log(`${LOG} skipped_after_callback`, { caseId: typedCase.id });
    return {
      caseId: typedCase.id,
      selectedRuleId: null,
      createdDeliveriesCount: 0,
      skippedExistingDeliveries: 0,
      skippedRecipients,
      warnings,
      managerRecipientFallbackUsed: false,
      ...(wantRuleDebug ? { ruleEvaluationDebug: [] } : {})
    };
  }

  mark(diag, "prepare_notifications_lookup_employee_start", {
    manager_bitrix_user_id: typedCase.manager_bitrix_user_id
  });
  const mid = caseManagerId;
  let typedHierarchy: ResolvedHierarchyRow | null = null;
  const { data: hierarchy, error: hierErr } = await withTimeout(
    supabase
      .from("org_resolved_hierarchy")
      .select(
        "manager_bitrix_user_id, rop_bitrix_user_id, rop_name, department_director_bitrix_user_id, department_director_name, company_director_bitrix_user_id, company_director_name"
      )
      .eq("manager_bitrix_user_id", mid)
      .maybeSingle(),
    DB_OP_MS,
    "org_resolved_hierarchy.select"
  );
  if (hierErr) throw new Error(hierErr.message);
  typedHierarchy = (hierarchy as ResolvedHierarchyRow | null) ?? null;
  mark(diag, "prepare_notifications_lookup_employee_done", { hasHierarchy: Boolean(typedHierarchy) });

  mark(diag, "prepare_notifications_rules_load_start", { caseId });
  const rules = await loadAlertNotificationRules(supabase);
  mark(diag, "prepare_notifications_rules_load_done", { count: rules.length });

  if (rules.length === 0) {
    warnings.push("no_alert_notification_rules");
    return {
      caseId: typedCase.id,
      selectedRuleId: null,
      createdDeliveriesCount: 0,
      skippedExistingDeliveries: 0,
      skippedRecipients,
      warnings,
      managerRecipientFallbackUsed: false,
      ...(wantRuleDebug ? { ruleEvaluationDebug: [] } : {})
    };
  }

  const now = new Date();
  const ctx: AlertRuleEvaluationContext = {
    missedCount: typedCase.missed_count,
    minutesSinceLastMissed: minutesBetween(now, typedCase.last_missed_at),
    /** False here: callers that reach this branch already gated on outbound/callback timestamps. */
    hasCallbackAfterMissed: false
  };

  mark(diag, "prepare_notifications_resolve_recipients_start", { missedCount: typedCase.missed_count });

  const dealUrl = dealUrlForMessageTemplate(typedCase.deal_url, typedCase.deal_id);
  const managerUid = mid;

  let created = 0;
  let lastMatchedRuleId: string | null = null;

  mark(diag, "prepare_notifications_insert_deliveries_start", { caseId });

  for (const rule of rules) {
    const evalDet = evaluateAlertRuleConditionDetailed(rule, ctx);

    let deliveryCreatedForRule = 0;
    let skippedExistingForRule = 0;

    if (!evalDet.finalMatched) {
      if (ruleEvaluationDebug) {
        ruleEvaluationDebug.push({
          ruleId: rule.id,
          ruleName: rule.name,
          logic: evalDet.logic,
          missedCountConditionMet: evalDet.missedCountConditionMet,
          timeWithoutCallbackConditionMet: evalDet.timeWithoutCallbackConditionMet,
          finalMatched: false,
          recipientsResolved: 0,
          deliveryCreated: 0,
          skippedExistingDeliveries: 0
        });
      }
      continue;
    }

    lastMatchedRuleId = rule.id;

    const specs = parseAlertRecipientSpecs(rule.recipients);
    const recipients = resolveAlertRecipients(
      specs,
      {
        managerBitrixUserId: managerUid,
        managerName: typedCase.manager_name,
        treatManagerFallback: treatFb,
        hierarchy: typedHierarchy
      },
      (msg) => warnings.push(`${msg}:rule=${rule.id}:${rule.name}`)
    );

    const recipientsResolved = recipients.length;

    for (const r of recipients) {
      if (!r.bitrix_user_id) {
        skippedRecipients.push({ role: r.recipient_role, reason: "recipient_user_missing" });
        continue;
      }

      const isDup = await alreadyDeliveredOrPending(supabase, {
        case_id: typedCase.id,
        alert_rule_id: rule.id,
        recipient_bitrix_user_id: r.bitrix_user_id
      });

      if (isDup) {
        skippedExistingDeliveries++;
        skippedExistingForRule++;
        skippedRecipients.push({ role: r.recipient_role, reason: "skipped_existing_delivery" });
        continue;
      }

      const displayManagerName =
        r.recipient_role === "manager" && treatFb && !typedCase.manager_name?.trim()
          ? `manager (${r.bitrix_user_id})`
          : typedCase.manager_name;

      const minutesWithout =
        ctx.minutesSinceLastMissed === null ? "0" : String(ctx.minutesSinceLastMissed);

      const messageText = renderMessageTemplate(rule.message_template, {
        message: defaultMessageLineForRecipientRole(r.recipient_role),
        manager_name: displayManagerName,
        deal_id: typedCase.deal_id,
        deal_title: typedCase.deal_title?.trim() || "",
        deal_url: dealUrl,
        contact_name: typedCase.contact_name,
        phone: formatPhoneForDisplay(typedCase.phone_normalized),
        missed_count: typedCase.missed_count,
        missed_at: typedCase.last_missed_at,
        case_id: typedCase.id,
        minutes_without_callback: minutesWithout,
        recipient_role: r.recipient_role,
        recipient_name: r.name ?? ""
      });

      const insertRow: Record<string, unknown> = {
        case_id: typedCase.id,
        rule_id: null,
        template_id: null,
        alert_rule_id: rule.id,
        recipient_role: r.recipient_role,
        recipient_bitrix_user_id: r.bitrix_user_id,
        recipient_name: r.name,
        message_text: messageText,
        delivery_status: "pending" as DeliveryStatus,
        provider_name: "bitrix_bot"
      };
      if (r.recipient_source) {
        insertRow.recipient_source = r.recipient_source;
      }

      const { error: insErr } = await withTimeout(
        supabase.from("notification_deliveries").insert(insertRow as never),
        DELIVERY_INSERT_TIMEOUT_MS,
        `notification_deliveries.insert:${r.recipient_role}`
      );
      if (insErr) {
        if (isAlertRuleRecipientDedupeViolation(insErr)) {
          skippedExistingDeliveries++;
          skippedExistingForRule++;
          skippedRecipients.push({ role: r.recipient_role, reason: "skipped_existing_delivery" });
          console.log(`${LOG} skip_dedupe_delivery`, {
            caseId: typedCase.id,
            ruleId: rule.id,
            role: r.recipient_role
          });
          continue;
        }
        throw new Error(insErr.message);
      }

      deliveryCreatedForRule++;
      created++;
      if (r.recipient_source === "call_event_manager_bitrix_user_id_fallback") {
        managerRecipientFallbackUsed = true;
      }
    }

    if (ruleEvaluationDebug) {
      ruleEvaluationDebug.push({
        ruleId: rule.id,
        ruleName: rule.name,
        logic: evalDet.logic,
        missedCountConditionMet: evalDet.missedCountConditionMet,
        timeWithoutCallbackConditionMet: evalDet.timeWithoutCallbackConditionMet,
        finalMatched: true,
        recipientsResolved,
        deliveryCreated: deliveryCreatedForRule,
        skippedExistingDeliveries: skippedExistingForRule
      });
    }
  }

  mark(diag, "prepare_notifications_resolve_recipients_done", {
    selectedRuleId: lastMatchedRuleId,
    recipientLoops: created
  });
  mark(diag, "prepare_notifications_insert_deliveries_done", { created });

  if (lastMatchedRuleId) {
    const { error: updErr } = await withTimeout(
      supabase
        .from("missed_call_cases")
        .update({
          last_triggered_alert_rule_id: lastMatchedRuleId,
          last_triggered_at: now.toISOString()
        })
        .eq("id", typedCase.id),
      DB_OP_MS,
      "missed_call_cases.update_triggered"
    );
    if (updErr) throw new Error(updErr.message);
  }

  return {
    caseId: typedCase.id,
    selectedRuleId: lastMatchedRuleId,
    createdDeliveriesCount: created,
    skippedExistingDeliveries,
    skippedRecipients,
    warnings,
    managerRecipientFallbackUsed,
    ...(ruleEvaluationDebug ? { ruleEvaluationDebug } : {})
  };
}

export type ExplainMissedCallAlertRulesResult = {
  caseId: string;
  skipped: boolean;
  skipReason?: string;
  evaluations: PrepareRuleEvaluationSnapshot[];
  warnings: string[];
};

/**
 * Dry-run: same predicates and recipient resolution as prepare, **no inserts**. For case-debug UX.
 */
export async function explainMissedCallAlertRulesForCase(
  caseId: string,
  treatFallback?: boolean
): Promise<ExplainMissedCallAlertRulesResult> {
  const supabase = createServiceRoleClient();
  const warnings: string[] = [];
  const evaluations: PrepareRuleEvaluationSnapshot[] = [];

  const { data: caseRow, error: caseErr } = await withTimeout(
    supabase
      .from("missed_call_cases")
      .select(
        "id, status, phone_normalized, deal_id, deal_url, deal_title, contact_name, manager_bitrix_user_id, manager_name, department_id, missed_count, last_missed_at, last_outbound_at, last_successful_callback_at, context"
      )
      .eq("id", caseId)
      .maybeSingle(),
    DB_OP_MS,
    "explain_missed_case.select"
  );
  if (caseErr) throw new Error(caseErr.message);
  if (!caseRow) {
    return {
      caseId,
      skipped: true,
      skipReason: "case_not_found",
      evaluations,
      warnings: ["case_not_found"]
    };
  }

  const typedCase = caseRow as MissedCallCaseRow;

  const caseStatus = String(typedCase.status ?? "").trim();
  if (caseStatus !== "open") {
    return {
      caseId: typedCase.id,
      skipped: true,
      skipReason: "case_not_open",
      evaluations,
      warnings: [...warnings, "prepare_skipped_case_not_open"]
    };
  }

  const caseManagerId = normalizeBitrixUserId(typedCase.manager_bitrix_user_id);
  if (!caseManagerId) {
    return {
      caseId: typedCase.id,
      skipped: true,
      skipReason: "missing_case_manager",
      evaluations,
      warnings: [...warnings, "prepare_skipped_missing_case_manager"]
    };
  }

  const outboundPrepareBlock = await outboundActivityBlocksMissedPrepare(supabase, {
    phone_normalized: typedCase.phone_normalized,
    context: typedCase.context
  });
  if (outboundPrepareBlock) {
    return {
      caseId: typedCase.id,
      skipped: true,
      skipReason: `outbound_blocked:${outboundPrepareBlock}`,
      evaluations,
      warnings: [...warnings, `prepare_blocked_${outboundPrepareBlock}`]
    };
  }

  if (hasCallbackAfterMissed(typedCase)) {
    return {
      caseId: typedCase.id,
      skipped: true,
      skipReason: "followup_after_last_missed",
      evaluations,
      warnings: [...warnings, "prepare_skipped_followup_after_last_missed"]
    };
  }

  const mid = caseManagerId;
  const treatFb = Boolean(treatFallback);
  const { data: hierarchy, error: hierErr } = await withTimeout(
    supabase
      .from("org_resolved_hierarchy")
      .select(
        "manager_bitrix_user_id, rop_bitrix_user_id, rop_name, department_director_bitrix_user_id, department_director_name, company_director_bitrix_user_id, company_director_name"
      )
      .eq("manager_bitrix_user_id", mid)
      .maybeSingle(),
    DB_OP_MS,
    "explain_org_hierarchy.select"
  );
  if (hierErr) throw new Error(hierErr.message);
  const typedHierarchy = (hierarchy as ResolvedHierarchyRow | null) ?? null;

  const rules = await loadAlertNotificationRules(supabase);

  const now = new Date();
  const ctx: AlertRuleEvaluationContext = {
    missedCount: typedCase.missed_count,
    minutesSinceLastMissed: minutesBetween(now, typedCase.last_missed_at),
    hasCallbackAfterMissed: false
  };

  const managerUid = mid;

  for (const rule of rules) {
    const evalDet = evaluateAlertRuleConditionDetailed(rule, ctx);

    if (!evalDet.finalMatched) {
      evaluations.push({
        ruleId: rule.id,
        ruleName: rule.name,
        logic: evalDet.logic,
        missedCountConditionMet: evalDet.missedCountConditionMet,
        timeWithoutCallbackConditionMet: evalDet.timeWithoutCallbackConditionMet,
        finalMatched: false,
        recipientsResolved: 0,
        deliveryCreated: 0,
        skippedExistingDeliveries: 0
      });
      continue;
    }

    const specs = parseAlertRecipientSpecs(rule.recipients);
    const recipients = resolveAlertRecipients(
      specs,
      {
        managerBitrixUserId: managerUid,
        managerName: typedCase.manager_name,
        treatManagerFallback: treatFb,
        hierarchy: typedHierarchy
      },
      (msg) => warnings.push(`${msg}:rule=${rule.id}:${rule.name}`)
    );

    evaluations.push({
      ruleId: rule.id,
      ruleName: rule.name,
      logic: evalDet.logic,
      missedCountConditionMet: evalDet.missedCountConditionMet,
      timeWithoutCallbackConditionMet: evalDet.timeWithoutCallbackConditionMet,
      finalMatched: true,
      recipientsResolved: recipients.length,
      deliveryCreated: 0,
      skippedExistingDeliveries: 0
    });
  }

  return { caseId: typedCase.id, skipped: false, evaluations, warnings };
}
