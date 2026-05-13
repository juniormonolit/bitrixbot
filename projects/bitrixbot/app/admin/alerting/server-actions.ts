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
