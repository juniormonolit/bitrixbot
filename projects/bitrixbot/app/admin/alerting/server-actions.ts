"use server";

import { revalidatePath } from "next/cache";
import { createServiceRoleClient } from "@/lib/supabase/server";
import { flagsForAlertingMode, flagsForStopAll, type AlertingModePreset } from "@/src/lib/bitrixbot/alerting-mode";
import { MESSAGE_TEMPLATE_BODY_DEFAULTS } from "@/src/lib/bitrixbot/message-template-defaults";
import { updateAlertingSettings } from "@/src/lib/bitrixbot/update-alerting-settings";

const MODE_PRESETS: AlertingModePreset[] = ["live", "live_with_mirror", "mirror_only"];

export async function applyAlertingModeAction(formData: FormData) {
  const mode = String(formData.get("alerting_mode") ?? "") as AlertingModePreset;
  if (!MODE_PRESETS.includes(mode)) {
    throw new Error("Недопустимый режим");
  }
  const reason = String(formData.get("updated_reason") ?? "").trim() || null;
  const flags = flagsForAlertingMode(mode);
  await updateAlertingSettings({
    ...flags,
    updated_reason: reason ?? `Консоль: режим ${mode}`
  });
  revalidatePath("/admin/alerting");
}

export async function stopAllSendingsAction(formData: FormData) {
  const reason = String(formData.get("stop_reason") ?? "").trim();
  if (!reason) {
    return;
  }
  await updateAlertingSettings({
    ...flagsForStopAll(),
    updated_reason: reason
  });
  revalidatePath("/admin/alerting");
}

export async function saveOrgAutoRefreshAction(formData: FormData) {
  const enabled = formData.has("org_structure_auto_refresh_enabled");
  const time = String(formData.get("org_structure_auto_refresh_time_local") ?? "04:00").trim();
  await updateAlertingSettings({
    org_structure_auto_refresh_enabled: enabled,
    org_structure_auto_refresh_time_local: time || "04:00"
  });
  revalidatePath("/admin/alerting");
}

export async function saveMessageTemplateAction(formData: FormData) {
  const id = String(formData.get("template_id") ?? "").trim();
  const body = String(formData.get("body") ?? "");
  if (!id) throw new Error("template_id missing");

  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("message_templates").update({ body }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/admin/alerting");
}

export async function resetMessageTemplateByCodeAction(formData: FormData) {
  const code = String(formData.get("code") ?? "").trim();
  const id = String(formData.get("template_id") ?? "").trim();
  const def = MESSAGE_TEMPLATE_BODY_DEFAULTS[code];
  if (!def || !id) throw new Error("unknown template code");

  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("message_templates").update({ body: def }).eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/admin/alerting");
}

const DEFAULT_NEW_ALERT_RULE_TEMPLATE = `{{message}}

Менеджер: {{manager_name}}
Телефон: {{phone}}
Сделка: {{deal_url}}
Пропущенных подряд: {{missed_count}}
Время без исходящего: {{minutes_without_callback}} мин.`;

function numOrNull(v: FormDataEntryValue | null): number | null {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function buildRecipientsFromForm(formData: FormData): unknown[] {
  const out: { type: string; userId?: string }[] = [];
  if (formData.has("recipient_manager")) out.push({ type: "responsible_manager" });
  if (formData.has("recipient_rop")) out.push({ type: "rop" });
  if (formData.has("recipient_director")) out.push({ type: "director" });
  const manualCsv = String(formData.get("manual_user_ids") ?? "");
  for (const part of manualCsv.split(/[,;\s]+/)) {
    const id = part.trim();
    if (id) out.push({ type: "manual_user_id", userId: id });
  }
  return out;
}

export async function saveAlertNotificationRuleAction(formData: FormData) {
  const supabase = createServiceRoleClient();
  const isCreate = formData.has("create");

  if (isCreate) {
    const name = String(formData.get("name") ?? "").trim();
    if (!name) throw new Error("name required");
    const { data: maxRow } = await supabase
      .from("alert_notification_rules")
      .select("sort_order")
      .order("sort_order", { ascending: false })
      .limit(1)
      .maybeSingle();
    const nextSort = ((maxRow as { sort_order?: number } | null)?.sort_order ?? 0) + 10;
    const { error } = await supabase.from("alert_notification_rules").insert({
      name,
      enabled: true,
      sort_order: nextSort,
      missed_count_threshold: 1,
      no_callback_minutes: null,
      condition_operator: "OR",
      recipients: [{ type: "responsible_manager" }],
      message_template: DEFAULT_NEW_ALERT_RULE_TEMPLATE
    });
    if (error) throw new Error(error.message);
    revalidatePath("/admin/alerting");
    return;
  }

  const id = String(formData.get("id") ?? "").trim();
  if (!id) throw new Error("id missing");

  const name = String(formData.get("name") ?? "").trim();
  if (!name) throw new Error("name required");
  const enabled = formData.has("enabled");
  const sort_order = Number(formData.get("sort_order") ?? 100) || 100;
  const missed_count_threshold = numOrNull(formData.get("missed_count_threshold"));
  const no_callback_minutes = numOrNull(formData.get("no_callback_minutes"));
  const condition_operator = String(formData.get("condition_operator") ?? "OR");
  if (condition_operator !== "AND" && condition_operator !== "OR") {
    throw new Error("invalid condition_operator");
  }
  const message_template = String(formData.get("message_template") ?? "");
  if (!message_template.trim()) throw new Error("message_template required");

  const recipients = buildRecipientsFromForm(formData);
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error("Нужен хотя бы один получатель");
  }

  const { error } = await supabase
    .from("alert_notification_rules")
    .update({
      name,
      enabled,
      sort_order,
      missed_count_threshold,
      no_callback_minutes,
      condition_operator,
      recipients,
      message_template
    })
    .eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/admin/alerting");
}

export async function deleteAlertNotificationRuleAction(formData: FormData) {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) throw new Error("id missing");
  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("alert_notification_rules").delete().eq("id", id);
  if (error) throw new Error(error.message);
  revalidatePath("/admin/alerting");
}

export async function duplicateAlertNotificationRuleAction(formData: FormData) {
  const id = String(formData.get("id") ?? "").trim();
  if (!id) throw new Error("id missing");
  const supabase = createServiceRoleClient();
  const { data: row, error: selErr } = await supabase.from("alert_notification_rules").select("*").eq("id", id).single();
  if (selErr) throw new Error(selErr.message);
  const r = { ...(row as Record<string, unknown>) };
  delete r.id;
  delete r.created_at;
  delete r.updated_at;
  const { data: maxRow } = await supabase
    .from("alert_notification_rules")
    .select("sort_order")
    .order("sort_order", { ascending: false })
    .limit(1)
    .maybeSingle();
  const nextSort = ((maxRow as { sort_order?: number } | null)?.sort_order ?? 0) + 10;
  const { error } = await supabase.from("alert_notification_rules").insert({
    ...r,
    name: `${String(r.name ?? "Правило")} (копия)`,
    sort_order: nextSort
  });
  if (error) throw new Error(error.message);
  revalidatePath("/admin/alerting");
}

export async function moveAlertNotificationRuleAction(formData: FormData) {
  const id = String(formData.get("id") ?? "").trim();
  const direction = String(formData.get("direction") ?? "");
  if (!id || (direction !== "up" && direction !== "down")) return;

  const supabase = createServiceRoleClient();
  const { data: rules, error } = await supabase
    .from("alert_notification_rules")
    .select("id, sort_order")
    .order("sort_order", { ascending: true });
  if (error) throw new Error(error.message);
  const arr = (rules ?? []) as { id: string; sort_order: number }[];
  const idx = arr.findIndex((r) => r.id === id);
  if (idx < 0) return;
  const j = direction === "up" ? idx - 1 : idx + 1;
  if (j < 0 || j >= arr.length) return;
  const a = arr[idx];
  const b = arr[j];
  const soA = a.sort_order ?? 0;
  const soB = b.sort_order ?? 0;
  const { error: e1 } = await supabase.from("alert_notification_rules").update({ sort_order: soB }).eq("id", a.id);
  if (e1) throw new Error(e1.message);
  const { error: e2 } = await supabase.from("alert_notification_rules").update({ sort_order: soA }).eq("id", b.id);
  if (e2) throw new Error(e2.message);
  revalidatePath("/admin/alerting");
}
