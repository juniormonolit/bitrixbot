import { createServiceRoleClient } from "@/lib/supabase/server";

export type AlertingSettings = {
  sending_enabled: boolean;
  mirror_enabled: boolean;
  mirror_bitrix_user_id: string | null;
  dry_run_mode: boolean;
  send_only_to_mirror: boolean;
  updated_by: string | null;
  updated_reason: string | null;
};

const defaults: AlertingSettings = {
  sending_enabled: false,
  mirror_enabled: true,
  mirror_bitrix_user_id: "2098",
  dry_run_mode: true,
  send_only_to_mirror: false,
  updated_by: null,
  updated_reason: null
};

function toBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  return fallback;
}

function toStringOrNull(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

export async function getAlertingSettings(): Promise<AlertingSettings> {
  const supabase = createServiceRoleClient();
  const { data, error } = await supabase
    .from("alerting_settings")
    .select("settings_payload")
    .eq("settings_key", "global")
    .maybeSingle();
  if (error) throw new Error(error.message);

  const payload = (data as { settings_payload?: unknown } | null)?.settings_payload;
  const obj = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};

  return {
    sending_enabled: toBool(obj.sending_enabled, defaults.sending_enabled),
    mirror_enabled: toBool(obj.mirror_enabled, defaults.mirror_enabled),
    mirror_bitrix_user_id: toStringOrNull(obj.mirror_bitrix_user_id) ?? defaults.mirror_bitrix_user_id,
    dry_run_mode: toBool(obj.dry_run_mode, defaults.dry_run_mode),
    send_only_to_mirror: toBool(obj.send_only_to_mirror, defaults.send_only_to_mirror),
    updated_by: toStringOrNull(obj.updated_by),
    updated_reason: toStringOrNull(obj.updated_reason)
  };
}

