import { createServiceRoleClient } from "@/lib/supabase/server";
import { AlertingSettings, getAlertingSettings } from "@/src/lib/bitrixbot/get-alerting-settings";

export type UpdateAlertingSettingsInput = Partial<{
  sending_enabled: boolean | string | null;
  mirror_enabled: boolean | string | null;
  mirror_bitrix_user_id: string | null;
  dry_run_mode: boolean | string | null;
  send_only_to_mirror: boolean | string | null;
  updated_by: string | null;
  updated_reason: string | null;
}>;

function normalizeBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return fallback;
}

function normalizeStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export async function updateAlertingSettings(
  input: UpdateAlertingSettingsInput
): Promise<AlertingSettings> {
  const current = await getAlertingSettings();

  const next: AlertingSettings = {
    sending_enabled: normalizeBool(input.sending_enabled, current.sending_enabled),
    mirror_enabled: normalizeBool(input.mirror_enabled, current.mirror_enabled),
    mirror_bitrix_user_id:
      normalizeStringOrNull(input.mirror_bitrix_user_id) ?? current.mirror_bitrix_user_id,
    dry_run_mode: normalizeBool(input.dry_run_mode, current.dry_run_mode),
    send_only_to_mirror: normalizeBool(input.send_only_to_mirror, current.send_only_to_mirror),
    updated_by: normalizeStringOrNull(input.updated_by) ?? current.updated_by,
    updated_reason: normalizeStringOrNull(input.updated_reason) ?? current.updated_reason
  };

  const supabase = createServiceRoleClient();
  const { error } = await supabase.from("alerting_settings").upsert(
    {
      settings_key: "global",
      settings_payload: next
    },
    { onConflict: "settings_key" }
  );
  if (error) throw new Error(error.message);

  return next;
}

