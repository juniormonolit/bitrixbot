import { createServiceRoleClient } from "@/lib/supabase/server";
import { buildDealUrl } from "@/src/lib/bitrixbot/build-deal-url";
import { parseRecipientRoles, RecipientRole } from "@/src/lib/bitrixbot/recipient-roles";
import { renderMessageTemplate } from "@/src/lib/bitrixbot/render-message-template";
import {
  NotificationRuleContext,
  NotificationRuleRow,
  selectNotificationRule
} from "@/src/lib/bitrixbot/select-notification-rule";

type MissedCallCaseRow = {
  id: string;
  phone_normalized: string;
  deal_id: number | null;
  deal_url: string | null;
  contact_name: string | null;
  manager_bitrix_user_id: string | null;
  manager_name: string | null;
  department_id: string | null;
  missed_count: number;
  last_missed_at: string;
  last_outbound_at: string | null;
  last_successful_callback_at: string | null;
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

type TemplateRow = {
  id: string;
  body: string;
  target_role: string | null;
};

type DeliveryStatus = "pending" | "sent" | "failed" | "skipped";

export type PrepareNotificationsResult = {
  caseId: string;
  selectedRuleId: string | null;
  createdDeliveriesCount: number;
  skippedRecipients: { role: RecipientRole; reason: string }[];
  warnings: string[];
};

function roleMessage(role: RecipientRole): string {
  if (role === "manager") return "СРОЧНО ПЕРЕЗВОНИ КЛИЕНТУ. ДО ТЕБЯ НЕ ДОЗВОНИЛИСЬ.";
  if (role === "rop") return "КЛИЕНТ НЕ ДОЗВОНИЛСЯ ДО МЕНЕДЖЕРА.";
  if (role === "department_director")
    return "ЭСКАЛАЦИЯ: ЕСТЬ ПОВТОРНЫЕ ПРОПУЩЕННЫЕ ЗВОНКИ.";
  return "ЭСКАЛАЦИЯ НА УРОВЕНЬ КОМПАНИИ: КЛИЕНТ НЕ МОЖЕТ ДОЗВОНИТЬСЯ.";
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

async function findActiveTemplateForRole(
  supabase: ReturnType<typeof createServiceRoleClient>,
  role: RecipientRole
): Promise<TemplateRow | null> {
  const { data, error } = await supabase
    .from("message_templates")
    .select("id, body, target_role")
    .eq("is_active", true)
    .eq("channel", "bitrix_chat")
    .eq("target_role", role)
    .limit(1);
  if (error) throw new Error(error.message);
  return (data?.[0] as TemplateRow | undefined) ?? null;
}

async function alreadyDeliveredOrPending(
  supabase: ReturnType<typeof createServiceRoleClient>,
  input: {
    case_id: string;
    rule_id: string | null;
    recipient_role: RecipientRole;
    recipient_bitrix_user_id: string | null;
  }
): Promise<boolean> {
  if (!input.rule_id) return false;
  if (!input.recipient_bitrix_user_id) return false;

  const { data, error } = await supabase
    .from("notification_deliveries")
    .select("id, delivery_status")
    .eq("case_id", input.case_id)
    .eq("rule_id", input.rule_id)
    .eq("recipient_role", input.recipient_role)
    .eq("recipient_bitrix_user_id", input.recipient_bitrix_user_id)
    .in("delivery_status", ["pending", "sent"])
    .limit(1);
  if (error) throw new Error(error.message);
  return Boolean(data && data.length > 0);
}

export async function prepareNotificationsForMissedCallCase(
  caseId: string
): Promise<PrepareNotificationsResult> {
  const supabase = createServiceRoleClient();

  const warnings: string[] = [];
  const skippedRecipients: { role: RecipientRole; reason: string }[] = [];

  const { data: caseRow, error: caseErr } = await supabase
    .from("missed_call_cases")
    .select(
      "id, phone_normalized, deal_id, deal_url, contact_name, manager_bitrix_user_id, manager_name, department_id, missed_count, last_missed_at, last_outbound_at, last_successful_callback_at"
    )
    .eq("id", caseId)
    .maybeSingle();
  if (caseErr) throw new Error(caseErr.message);
  if (!caseRow) {
    return {
      caseId,
      selectedRuleId: null,
      createdDeliveriesCount: 0,
      skippedRecipients: [],
      warnings: ["case_not_found"]
    };
  }

  const typedCase = caseRow as MissedCallCaseRow;

  const { data: hierarchy, error: hierErr } = await supabase
    .from("org_resolved_hierarchy")
    .select(
      "manager_bitrix_user_id, rop_bitrix_user_id, rop_name, department_director_bitrix_user_id, department_director_name, company_director_bitrix_user_id, company_director_name"
    )
    .eq("manager_bitrix_user_id", typedCase.manager_bitrix_user_id ?? "")
    .maybeSingle();
  if (hierErr) throw new Error(hierErr.message);
  const typedHierarchy = (hierarchy as ResolvedHierarchyRow | null) ?? null;

  const { data: rules, error: rulesErr } = await supabase
    .from("notification_rules")
    .select(
      "id, is_active, sort_order, trigger_type, missed_count_from, missed_count_to, delay_minutes, recipient_roles, stop_processing"
    )
    .eq("is_active", true);
  if (rulesErr) throw new Error(rulesErr.message);

  const now = new Date();
  const context: NotificationRuleContext = {
    missedCount: typedCase.missed_count,
    minutesSinceLastMissed: minutesBetween(now, typedCase.last_missed_at),
    hasCallbackAfterMissed: hasCallbackAfterMissed(typedCase)
  };

  const selected = selectNotificationRule((rules ?? []) as NotificationRuleRow[], context);
  if (!selected) {
    return {
      caseId,
      selectedRuleId: null,
      createdDeliveriesCount: 0,
      skippedRecipients,
      warnings
    };
  }

  const roles = parseRecipientRoles(selected.recipient_roles);
  if (roles.length === 0) {
    warnings.push("rule_has_no_recipient_roles");
    return {
      caseId,
      selectedRuleId: selected.id,
      createdDeliveriesCount: 0,
      skippedRecipients,
      warnings
    };
  }

  const recipients: Array<{
    role: RecipientRole;
    bitrix_user_id: string | null;
    name: string | null;
  }> = roles.map((role) => {
    if (role === "manager") {
      return {
        role,
        bitrix_user_id: typedCase.manager_bitrix_user_id,
        name: typedCase.manager_name
      };
    }
    if (role === "rop") {
      return {
        role,
        bitrix_user_id: typedHierarchy?.rop_bitrix_user_id ?? null,
        name: typedHierarchy?.rop_name ?? null
      };
    }
    if (role === "department_director") {
      return {
        role,
        bitrix_user_id: typedHierarchy?.department_director_bitrix_user_id ?? null,
        name: typedHierarchy?.department_director_name ?? null
      };
    }
    return {
      role,
      bitrix_user_id: typedHierarchy?.company_director_bitrix_user_id ?? null,
      name: typedHierarchy?.company_director_name ?? null
    };
  });

  let created = 0;

  for (const r of recipients) {
    if (!r.bitrix_user_id) {
      skippedRecipients.push({ role: r.role, reason: "recipient_user_missing" });
      continue;
    }

    const template = await findActiveTemplateForRole(supabase, r.role);
    if (!template) {
      skippedRecipients.push({ role: r.role, reason: "template_missing" });
      continue;
    }

    const dealUrl = typedCase.deal_url?.trim() ? typedCase.deal_url : buildDealUrl(typedCase.deal_id);

    const messageText = renderMessageTemplate(template.body, {
      message: roleMessage(r.role),
      manager_name: typedCase.manager_name,
      deal_id: typedCase.deal_id,
      deal_url: dealUrl,
      contact_name: typedCase.contact_name,
      phone: typedCase.phone_normalized,
      missed_count: typedCase.missed_count
    });

    const isDup = await alreadyDeliveredOrPending(supabase, {
      case_id: typedCase.id,
      rule_id: selected.id,
      recipient_role: r.role,
      recipient_bitrix_user_id: r.bitrix_user_id
    });

    if (isDup) {
      skippedRecipients.push({ role: r.role, reason: "duplicate_delivery" });
      continue;
    }

    const { error: insErr } = await supabase.from("notification_deliveries").insert({
      case_id: typedCase.id,
      rule_id: selected.id,
      template_id: template.id,
      recipient_role: r.role,
      recipient_bitrix_user_id: r.bitrix_user_id,
      recipient_name: r.name,
      message_text: messageText,
      delivery_status: "pending" as DeliveryStatus,
      provider_name: "bitrix_bot"
    });
    if (insErr) throw new Error(insErr.message);

    created++;
  }

  const { error: updErr } = await supabase
    .from("missed_call_cases")
    .update({ last_triggered_rule_id: selected.id, last_triggered_at: now.toISOString() })
    .eq("id", typedCase.id);
  if (updErr) throw new Error(updErr.message);

  return {
    caseId: typedCase.id,
    selectedRuleId: selected.id,
    createdDeliveriesCount: created,
    skippedRecipients,
    warnings
  };
}

