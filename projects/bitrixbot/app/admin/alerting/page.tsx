import { env } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { getAlertingDashboardSummary } from "@/src/lib/bitrixbot/alerting-dashboard";
import { getAlertingSettings } from "@/src/lib/bitrixbot/get-alerting-settings";
import {
  AlertingConsole,
  type CaseRow,
  type DeliveryRow,
  type MirrorDeliveryRow,
  type OrgStructureSnapshot,
  type TemplatePanelRow
} from "./alerting-console";

function isAuthorized(searchParams: Record<string, string | string[] | undefined>): boolean {
  const secret = typeof searchParams.secret === "string" ? searchParams.secret : "";
  return Boolean(secret) && secret === env.DEBUG_SECRET;
}

async function fetchLastCases(): Promise<CaseRow[]> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("missed_call_cases")
    .select(
      "id, status, phone_normalized, manager_name, deal_id, missed_count, last_missed_at"
    )
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

async function fetchOrgStructureSnapshot(): Promise<OrgStructureSnapshot> {
  const supabase = createServiceRoleClient();
  const [{ count: empCount }, { count: hierCount }, { data: mappingRows }] = await Promise.all([
    supabase.from("employees").select("id", { count: "exact", head: true }),
    supabase.from("org_resolved_hierarchy").select("manager_bitrix_user_id", { count: "exact", head: true }),
    supabase
      .from("org_resolved_hierarchy")
      .select("id, manager_bitrix_user_id, manager_name, rop_bitrix_user_id, rop_name, department_name, resolved_at")
      .order("resolved_at", { ascending: false })
      .limit(80)
  ]);
  return {
    employeeCount: empCount ?? 0,
    hierarchyRowCount: hierCount ?? 0,
    mappingRows: (mappingRows ?? []) as OrgStructureSnapshot["mappingRows"]
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
    orgSnapshot
  ] = await Promise.all([
    getAlertingSettings(),
    getAlertingDashboardSummary(),
    fetchLastCases(),
    fetchLastDeliveries(),
    fetchLastMirrorDeliveries(),
    fetchTemplateByRole("manager"),
    fetchTemplateByRole("rop"),
    fetchOrgStructureSnapshot()
  ]);

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
    />
  );
}
