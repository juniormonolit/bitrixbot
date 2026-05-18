import { createServiceRoleClient } from "@/lib/supabase/server";
import { selectNotificationRule, NotificationRuleRow } from "@/src/lib/bitrixbot/select-notification-rule";
import { prepareNotificationsForMissedCallCase } from "@/src/lib/bitrixbot/prepare-notifications-for-missed-call-case";
import { outboundActivityBlocksMissedPrepare } from "@/src/lib/bitrixbot/alerting-prepare-outbound-guard";

type CaseRow = {
  id: string;
  phone_normalized: string;
  missed_count: number;
  last_missed_at: string;
  last_outbound_at: string | null;
  last_successful_callback_at: string | null;
  manager_bitrix_user_id: string | null;
};

export type NoCallbackEscalationsSummary = {
  scannedCases: number;
  executed: number;
  skipped: number;
  failed: number;
  createdDeliveries: number;
  skippedExistingDeliveries: number;
  warnings: string[];
};

function minutesSince(now: Date, iso: string): number | null {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return Math.floor((now.getTime() - t) / 60000);
}

function hasCallbackAfter(caseRow: CaseRow): boolean {
  const lastMissed = new Date(caseRow.last_missed_at).getTime();
  if (!Number.isFinite(lastMissed)) return false;

  const out = caseRow.last_outbound_at ? new Date(caseRow.last_outbound_at).getTime() : NaN;
  if (Number.isFinite(out) && out >= lastMissed) return true;

  const cb = caseRow.last_successful_callback_at ? new Date(caseRow.last_successful_callback_at).getTime() : NaN;
  if (Number.isFinite(cb) && cb >= lastMissed) return true;

  return false;
}

async function executionExists(
  supabase: ReturnType<typeof createServiceRoleClient>,
  caseId: string,
  ruleId: string
): Promise<boolean> {
  const { data, error } = await supabase
    .from("case_rule_executions")
    .select("id, execution_status")
    .eq("case_id", caseId)
    .eq("rule_id", ruleId)
    .limit(1);
  if (error) throw new Error(error.message);
  return Boolean(data && data.length > 0);
}

export async function processNoCallbackEscalations(
  limit: number = 100
): Promise<NoCallbackEscalationsSummary> {
  const supabase = createServiceRoleClient();
  const warnings: string[] = [];

  const { data: rules, error: rulesErr } = await supabase
    .from("notification_rules")
    .select(
      "id, is_active, sort_order, trigger_type, missed_count_from, missed_count_to, delay_minutes, recipient_roles, stop_processing"
    )
    .eq("is_active", true);
  if (rulesErr) throw new Error(rulesErr.message);

  const { data: cases, error: casesErr } = await supabase
    .from("missed_call_cases")
    .select(
      "id, phone_normalized, manager_bitrix_user_id, missed_count, last_missed_at, last_outbound_at, last_successful_callback_at"
    )
    .eq("status", "open")
    .order("last_missed_at", { ascending: true })
    .limit(limit);
  if (casesErr) throw new Error(casesErr.message);

  const now = new Date();

  let executed = 0;
  let skipped = 0;
  let failed = 0;
  let createdDeliveries = 0;
  let skippedExistingDeliveries = 0;

  for (const row of (cases ?? []) as CaseRow[]) {
    try {
      if (hasCallbackAfter(row)) {
        skipped++;
        continue;
      }

      const outboundBlock = await outboundActivityBlocksMissedPrepare(supabase, {
        phone_normalized: row.phone_normalized,
        last_missed_at: row.last_missed_at,
        manager_bitrix_user_id: row.manager_bitrix_user_id ?? null
      });
      if (outboundBlock) {
        skipped++;
        warnings.push(`${row.id}:escalation_blocked_${outboundBlock}`);
        continue;
      }

      const context = {
        missedCount: row.missed_count,
        minutesSinceLastMissed: minutesSince(now, row.last_missed_at),
        hasCallbackAfterMissed: false
      };

      const selected = selectNotificationRule((rules ?? []) as NotificationRuleRow[], context);
      if (!selected || selected.trigger_type !== "no_callback_after") {
        skipped++;
        continue;
      }

      const exists = await executionExists(supabase, row.id, selected.id);
      if (exists) {
        skipped++;
        continue;
      }

      const { error: insExecErr } = await supabase.from("case_rule_executions").insert({
        case_id: row.id,
        rule_id: selected.id,
        execution_status: "executed",
        triggered_at: now.toISOString(),
        notes: "SLA no_callback_after triggered"
      });
      if (insExecErr) throw new Error(insExecErr.message);

      const prep = await prepareNotificationsForMissedCallCase(row.id);
      createdDeliveries += prep.createdDeliveriesCount;
      skippedExistingDeliveries += prep.skippedExistingDeliveries;
      warnings.push(...prep.warnings.map((w) => `${row.id}:${w}`));

      executed++;
    } catch (e) {
      failed++;
      warnings.push(
        `${row.id}:no_callback_failed:${e instanceof Error ? e.message : String(e)}`
      );
    }
  }

  return {
    scannedCases: (cases ?? []).length,
    executed,
    skipped,
    failed,
    createdDeliveries,
    skippedExistingDeliveries,
    warnings
  };
}

