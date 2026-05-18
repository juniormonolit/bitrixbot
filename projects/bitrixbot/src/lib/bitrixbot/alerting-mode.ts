import { DEFAULT_MIRROR_BITRIX_USER_ID } from "@/lib/bitrixbot/alerting-constants";
import type { AlertingSettings } from "@/lib/bitrixbot/get-alerting-settings";

export { DEFAULT_MIRROR_BITRIX_USER_ID } from "@/lib/bitrixbot/alerting-constants";

export type AlertingMode =
  | "live"
  | "live_with_mirror"
  | "mirror_only"
  | "stopped"
  | "custom";

type FlagsSlice = Pick<
  AlertingSettings,
  "sending_enabled" | "dry_run_mode" | "send_only_to_mirror" | "mirror_enabled" | "mirror_bitrix_user_id"
>;

/**
 * Выводит режим из текущих флагов (без отдельного поля mode в БД).
 * Пресеты режимов задают однозначный набор флагов; любые другие сочетания → custom.
 */
export function deriveAlertingMode(settings: AlertingSettings): AlertingMode {
  const s = settings;

  if (!s.sending_enabled && s.dry_run_mode) {
    return "stopped";
  }

  if (!s.sending_enabled) {
    return "stopped";
  }

  if (s.sending_enabled && s.dry_run_mode) {
    return "custom";
  }

  const live: FlagsSlice = {
    sending_enabled: true,
    dry_run_mode: false,
    send_only_to_mirror: false,
    mirror_enabled: false,
    mirror_bitrix_user_id: s.mirror_bitrix_user_id
  };

  const liveWithMirror: FlagsSlice = {
    sending_enabled: true,
    dry_run_mode: false,
    send_only_to_mirror: false,
    mirror_enabled: true,
    mirror_bitrix_user_id: DEFAULT_MIRROR_BITRIX_USER_ID
  };

  const mirrorOnly: FlagsSlice = {
    sending_enabled: true,
    dry_run_mode: false,
    send_only_to_mirror: true,
    mirror_enabled: true,
    mirror_bitrix_user_id: DEFAULT_MIRROR_BITRIX_USER_ID
  };

  if (flagsEqual(s, live)) return "live";
  if (flagsEqual(s, liveWithMirror)) return "live_with_mirror";
  if (flagsEqual(s, mirrorOnly)) return "mirror_only";

  return "custom";
}

function flagsEqual(a: AlertingSettings, b: FlagsSlice): boolean {
  return (
    a.sending_enabled === b.sending_enabled &&
    a.dry_run_mode === b.dry_run_mode &&
    a.send_only_to_mirror === b.send_only_to_mirror &&
    a.mirror_enabled === b.mirror_enabled &&
    String(a.mirror_bitrix_user_id ?? "") === String(b.mirror_bitrix_user_id ?? "")
  );
}

export type AlertingModePreset = Exclude<AlertingMode, "stopped" | "custom">;

export function flagsForAlertingMode(mode: AlertingModePreset): Partial<AlertingSettings> {
  switch (mode) {
    case "live":
      return {
        sending_enabled: true,
        dry_run_mode: false,
        send_only_to_mirror: false,
        mirror_enabled: false
      };
    case "live_with_mirror":
      return {
        sending_enabled: true,
        dry_run_mode: false,
        send_only_to_mirror: false,
        mirror_enabled: true,
        mirror_bitrix_user_id: DEFAULT_MIRROR_BITRIX_USER_ID
      };
    case "mirror_only":
      return {
        sending_enabled: true,
        dry_run_mode: false,
        send_only_to_mirror: true,
        mirror_enabled: true,
        mirror_bitrix_user_id: DEFAULT_MIRROR_BITRIX_USER_ID
      };
    default:
      return {};
  }
}

export function flagsForStopAll(): Partial<AlertingSettings> {
  return {
    sending_enabled: false,
    dry_run_mode: true
  };
}

export function alertingModeLabel(mode: AlertingMode): string {
  switch (mode) {
    case "live":
      return "Боевой режим";
    case "live_with_mirror":
      return "Боевой + дубль на mirror";
    case "mirror_only":
      return "Только mirror";
    case "stopped":
      return "СТОП (отправка выключена)";
    case "custom":
      return "Нестандартная комбинация флагов";
    default:
      return mode;
  }
}
