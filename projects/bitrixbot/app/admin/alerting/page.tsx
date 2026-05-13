import { env } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getAlertingDashboardSummary } from "@/src/lib/bitrixbot/alerting-dashboard";
import { getCallEventManagerDiagnostics } from "@/src/lib/bitrixbot/call-event-manager-diagnostics";
import { getAlertingSettings } from "@/src/lib/bitrixbot/get-alerting-settings";
import type { AlertNotificationRuleRow } from "@/src/lib/bitrixbot/alert-notification-rule-engine";
import {
  AlertingConsole,
  type AlertRulesReadiness,
  type CaseRow,
  type DeliveryRow,
  type MirrorDeliveryRow,
  type OrgHierarchyRow,
  type OrgHierarchyStats,
  type OrgStructureSnapshot,
  type TemplatePanelRow
} from "./alerting-console";

function isAuthorized(searchParams: Record<string, string | string[] | undefined>): boolean {
  const secret = typeof searchParams.secret === "string" ? searchParams.secret : "";
  return Boolean(secret && secret === env.DEBUG_SECRET);
}

async function fetchLastCases(): Promise<CaseRow[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("missed_call_cases")
    .select("id, status, phone_normalized, manager_name, deal_id, missed_count, last_missed_at")
    .order("last_missed_at", { ascending: false })
    .limit(20);
  if (error) throw new Error(error.message);
  return (data ?? []) as CaseRow[];
}

async function fetchLastDeliveries(): Promise<DeliveryRow[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("notification_deliveries")
    .select(
      "id, created_at, case_id, recipient_role, recipient_name, recipient_bitrix_user_id, delivery_status, message_text, error_message"
    )
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as DeliveryRow[];
}

async function fetchLastMirrorDeliveries(): Promise<MirrorDeliveryRow[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("notification_delivery_mirrors")
    .select(
      "id, created_at, delivery_id, mirror_bitrix_user_id, delivery_status, error_message, message_text"
    )
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) throw new Error(error.message);
  return (data ?? []) as MirrorDeliveryRow[];
}

async function fetchTemplateByRole(role: string): Promise<TemplatePanelRow | null> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("message_templates")
    .select("id, code, name, body, target_role")
    .eq("channel", "bitrix_chat")
    .eq("is_active", true)
    .eq("target_role", role)
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return (data as TemplatePanelRow | null) ?? null;
}

const PAGE = 1000;

type HierDbRow = {
  id: string;
  manager_bitrix_user_id: string;
  manager_name: string | null;
  department_name: string | null;
  rop_bitrix_user_id: string | null;
  rop_name: string | null;
  department_director_bitrix_user_id: string | null;
  department_director_name: string | null;
  company_director_bitrix_user_id: string | null;
  company_director_name: string | null;
  resolved_at: string;
};

function mapHierarchyRow(r: HierDbRow): OrgHierarchyRow {
  const dirId = r.department_director_bitrix_user_id?.trim()
    ? r.department_director_bitrix_user_id.trim()
    : r.company_director_bitrix_user_id?.trim() || null;
  const dirName = r.department_director_bitrix_user_id?.trim()
    ? r.department_director_name ?? null
    : r.company_director_name ?? null;
  return {
    id: r.id,
    manager_bitrix_user_id: r.manager_bitrix_user_id,
    manager_name: r.manager_name,
    department_name: r.department_name,
    rop_bitrix_user_id: r.rop_bitrix_user_id,
    rop_name: r.rop_name,
    director_bitrix_user_id: dirId,
    director_name: dirName,
    resolved_at: r.resolved_at
  };
}

async function fetchOrgHierarchyRows(): Promise<OrgHierarchyRow[]> {
  const supabase = createServiceRoleClient();
  const all: HierDbRow[] = [];
  let from = 0;
  const select =
    "id, manager_bitrix_user_id, manager_name, department_name, rop_bitrix_user_id, rop_name, department_director_bitrix_user_id, department_director_name, company_director_bitrix_user_id, company_director_name, resolved_at";
  while (true) {
    const { data, error } = await supabase
      .from("org_resolved_hierarchy")
      .select(select)
      .order("manager_bitrix_user_id", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message);
    const chunk = (data ?? []) as HierDbRow[];
    all.push(...chunk);
    if (chunk.length < PAGE) break;
    from += PAGE;
  }
  return all.map(mapHierarchyRow);
}

function computeHierarchyStats(rows: OrgHierarchyRow[]): OrgHierarchyStats {
  const total = rows.length;
  let withRop = 0;
  let withDirector = 0;
  for (const r of rows) {
    if (r.rop_bitrix_user_id) withRop++;
    if (r.director_bitrix_user_id) withDirector++;
  }
  return {
    total,
    withRop,
    withoutRop: total - withRop,
    withDirector,
    withoutDirector: total - withDirector
  };
}

async function fetchOrgStructureSnapshot(): Promise<OrgStructureSnapshot> {
  const supabase = createServiceRoleClient();
  const [{ count: empCount }, { count: hierCount }, hierarchyRows] = await Promise.all([
    supabase.from("employees").select("id", { count: "exact", head: true }),
    supabase.from("org_resolved_hierarchy").select("manager_bitrix_user_id", { count: "exact", head: true }),
    fetchOrgHierarchyRows()
  ]);
  return {
    employeeCount: empCount ?? 0,
    hierarchyRowCount: hierCount ?? 0,
    hierarchyRows,
    hierarchyStats: computeHierarchyStats(hierarchyRows)
  };
}

async function fetchAlertNotificationRules(): Promise<AlertNotificationRuleRow[]> {
  const supabase = createServiceRoleClient();
  const all: AlertNotificationRuleRow[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase
      .from("alert_notification_rules")
      .select(
        "id, name, enabled, sort_order, missed_count_threshold, no_callback_minutes, condition_operator, recipients, message_template"
      )
      .order("sort_order", { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      console.warn("[admin/alerting] alert_notification_rules fetch failed", error.message);
      return [];
    }
    const chunk = (data ?? []) as AlertNotificationRuleRow[];
    all.push(...chunk);
    if (chunk.length < PAGE) break;
    from += PAGE;
  }
  return all;
}

function hasResponsibleManagerInRecipients(recipients: unknown): boolean {
  if (!Array.isArray(recipients)) return false;
  for (const x of recipients) {
    if (x && typeof x === "object" && (x as { type?: string }).type === "responsible_manager") return true;
  }
  return false;
}

function fetchAlertRulesReadiness(rules: AlertNotificationRuleRow[]): AlertRulesReadiness {
  const enabledRules = rules.filter((r) => r.enabled);
  const hasResponsibleManagerRule = enabledRules.some((r) => hasResponsibleManagerInRecipients(r.recipients));
  return {
    enabledRulesCount: enabledRules.length,
    hasResponsibleManagerRule,
    tableMissing: rules.length === 0
  };
}

export default async function AlertingConsolePage({
  searchParams
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  if (!isAuthorized(sp)) {
    return (
      <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center px-6 py-16">
        <div className="rounded-2xl border border-white/10 bg-white/5 p-8 text-center shadow-lg">
          <h1 className="text-xl font-semibold text-white">Доступ запрещён</h1>
          <p className="mt-4 text-sm leading-relaxed text-white/70">
            Откройте консоль с корректным secret-параметром в адресной строке.
          </p>
          <p className="mt-3 text-xs text-white/45">
            Пример: <code className="rounded bg-black/30 px-1.5 py-0.5 text-white/75">/admin/alerting?secret=…</code>
          </p>
        </div>
      </main>
    );
  }

  const secret = typeof sp.secret === "string" ? sp.secret : "";

  const [
    settings,
    summary,
    cases,
    deliveries,
    mirrorDeliveries,
    tplManager,
    tplRop,
    orgSnapshot,
    managerCallDiagnostics,
    alertRules
  ] = await Promise.all([
    getAlertingSettings(),
    getAlertingDashboardSummary(),
    fetchLastCases(),
    fetchLastDeliveries(),
    fetchLastMirrorDeliveries(),
    fetchTemplateByRole("manager"),
    fetchTemplateByRole("rop"),
    fetchOrgStructureSnapshot(),
    getCallEventManagerDiagnostics(),
    fetchAlertNotificationRules()
  ]);

  const alertRulesReadiness = fetchAlertRulesReadiness(alertRules);

  return (
    <AlertingConsole
      secret={secret}
      settings={settings}
      summary={summary}
      cases={cases}
      deliveries={deliveries}
      mirrorDeliveries={mirrorDeliveries}
      templates={{ manager: tplManager, rop: tplRop }}
      orgSnapshot={orgSnapshot}
      managerCallDiagnostics={managerCallDiagnostics}
      alertRules={alertRules}
      alertRulesReadiness={alertRulesReadiness}
    />
  );
}
