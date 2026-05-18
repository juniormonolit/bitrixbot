import { createServiceRoleClient } from "@/lib/supabase/server";
import { withTimeout } from "@/src/lib/bitrixbot/async-timeout";
import { getAlertingSettings } from "@/src/lib/bitrixbot/get-alerting-settings";
import { refreshPendingDeliveryMessagePhoneLine } from "@/src/lib/bitrixbot/re-enrich-case-deal";
import { sendBitrixMessage } from "@/src/lib/bitrixbot/send-bitrix-message";
import { outboundActivityBlocksMissedPrepare } from "@/src/lib/bitrixbot/alerting-prepare-outbound-guard";
import { isValidAlertRecipientBitrixUserId } from "@/src/lib/bitrixbot/bitrix-user-id";

type DeliveryRow = {
  id: string;
  case_id: string;
  rule_id: string | null;
  recipient_role: string;
  recipient_bitrix_user_id: string | null;
  recipient_name: string | null;
  message_text: string;
  delivery_status: string;
  created_at: string;
};

type MirrorRow = {
  id: string;
  delivery_status: string;
};

const SKIPPED_PRIMARY_MIRROR_ONLY_MESSAGE =
  "Skipped: send_only_to_mirror mode is enabled";

const BAD_ALERT_MESSAGE_FRAGMENTS = ["Менеджер: Не назначен", "Основной получатель: Не назначен"];

export type ProcessPendingDeliveriesSummary = {
  mode: "blocked_by_kill_switch" | "blocked_by_dry_run" | "mirror_only_test" | "live";
  scannedDeliveries: number;
  sentDeliveries: number;
  failedDeliveries: number;
  /** Primary rows marked `skipped` in mirror-only live processing (never sent to primary). */
  skippedPrimaryDeliveries: number;
  mirroredDeliveries: number;
  failedMirrors: number;
  warnings: string[];
};

function buildMirrorMessage(input: {
  recipient_name: string | null;
  recipient_role: string;
  recipient_bitrix_user_id: string | null;
  case_id: string;
  original_message_text: string;
}): string {
  const recipientLabel = input.recipient_name
    ? `${input.recipient_name} (${input.recipient_role})`
    : `${input.recipient_role}${input.recipient_bitrix_user_id ? ` (${input.recipient_bitrix_user_id})` : ""}`;

  return [
    "[Дубль уведомления]",
    `Основной получатель: ${recipientLabel}`,
    `Case ID: ${input.case_id}`,
    "",
    input.original_message_text
  ].join("\n");
}

async function upsertMirrorRow(
  supabase: ReturnType<typeof createServiceRoleClient>,
  input: {
    delivery_id: string;
    mirror_bitrix_user_id: string;
    message_text: string;
  }
): Promise<MirrorRow> {
  const { data, error } = await supabase
    .from("notification_delivery_mirrors")
    .upsert(
      {
        delivery_id: input.delivery_id,
        mirror_bitrix_user_id: input.mirror_bitrix_user_id,
        message_text: input.message_text,
        delivery_status: "pending",
        provider_name: "bitrix_bot"
      },
      { onConflict: "delivery_id,mirror_bitrix_user_id" }
    )
    .select("id, delivery_status")
    .single();
  if (error) throw new Error(error.message);
  return data as MirrorRow;
}

export async function processPendingDeliveries(
  limit: number = 50
): Promise<ProcessPendingDeliveriesSummary> {
  const settings = await getAlertingSettings();

  if (!settings.sending_enabled) {
    return {
      mode: "blocked_by_kill_switch",
      scannedDeliveries: 0,
      sentDeliveries: 0,
      failedDeliveries: 0,
      skippedPrimaryDeliveries: 0,
      mirroredDeliveries: 0,
      failedMirrors: 0,
      warnings: ["sending_enabled=false"]
    };
  }

  if (settings.dry_run_mode) {
    return {
      mode: "blocked_by_dry_run",
      scannedDeliveries: 0,
      sentDeliveries: 0,
      failedDeliveries: 0,
      skippedPrimaryDeliveries: 0,
      mirroredDeliveries: 0,
      failedMirrors: 0,
      warnings: ["dry_run_mode=true"]
    };
  }

  const mode: ProcessPendingDeliveriesSummary["mode"] = settings.send_only_to_mirror
    ? "mirror_only_test"
    : "live";

  const supabase = createServiceRoleClient();
  const { data: deliveries, error } = await supabase.rpc("fetch_valid_pending_notification_deliveries", {
    p_limit: Math.max(1, Math.floor(limit))
  });
  if (error) throw new Error(error.message);

  let sentDeliveries = 0;
  let failedDeliveries = 0;
  let skippedPrimaryDeliveries = 0;
  let mirroredDeliveries = 0;
  let failedMirrors = 0;
  const warnings: string[] = [];

  async function markPrimarySkippedMirrorOnly(deliveryId: string) {
    const { error: skipErr } = await supabase
      .from("notification_deliveries")
      .update({
        delivery_status: "skipped",
        error_message: SKIPPED_PRIMARY_MIRROR_ONLY_MESSAGE,
        sent_at: null,
        provider_message_id: null
      })
      .eq("id", deliveryId);
    if (skipErr) throw new Error(skipErr.message);
  }

  for (const d of (deliveries ?? []) as DeliveryRow[]) {
    const now = new Date().toISOString();

    let messageText = d.message_text;

    try {
      const { data: caseMini, error: cmErr } = await withTimeout(
        supabase
          .from("missed_call_cases")
          .select("phone_normalized, manager_bitrix_user_id, last_missed_at")
          .eq("id", d.case_id)
          .maybeSingle(),
        2500,
        `pending_case_mini:${d.case_id}`
      );
      if (!cmErr && caseMini) {
        const typedMini = caseMini as {
          phone_normalized: string;
          manager_bitrix_user_id: string | null;
          last_missed_at: string;
        };

        if (!isValidAlertRecipientBitrixUserId(typedMini.manager_bitrix_user_id)) {
          const { error: skipErr } = await supabase
            .from("notification_deliveries")
            .update({
              delivery_status: "skipped",
              error_message: "guard_before_send:missing_case_manager_bitrix_user_id"
            })
            .eq("id", d.id);
          if (skipErr) throw new Error(skipErr.message);
          warnings.push(`${d.id}:skipped_missing_case_manager`);
          continue;
        }

        const blockReason = await outboundActivityBlocksMissedPrepare(supabase, {
          phone_normalized: typedMini.phone_normalized,
          last_missed_at: typedMini.last_missed_at,
          manager_bitrix_user_id: typedMini.manager_bitrix_user_id
        });
        if (blockReason) {
          const { error: skipErr } = await supabase
            .from("notification_deliveries")
            .update({
              delivery_status: "skipped",
              error_message: `blocked_outbound_before_send:${blockReason}`
            })
            .eq("id", d.id);
          if (skipErr) throw new Error(skipErr.message);
          warnings.push(`${d.id}:send_blocked_${blockReason}`);
          continue;
        }
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      warnings.push(`${d.id}:outbound_guard_before_send_failed:${m}`);
    }

    try {
      const phonePatched = await refreshPendingDeliveryMessagePhoneLine(supabase, d.id, d.case_id);
      if (phonePatched.updated) {
        warnings.push(`delivery_phone_line_patched:${d.id}`);
        const { data: dFresh2 } = await supabase
          .from("notification_deliveries")
          .select("message_text")
          .eq("id", d.id)
          .maybeSingle();
        if (dFresh2 && typeof (dFresh2 as { message_text?: string }).message_text === "string") {
          messageText = (dFresh2 as { message_text: string }).message_text;
        }
      }
    } catch {
      warnings.push(`delivery_phone_line_patch_failed:${d.id}`);
    }

    if (BAD_ALERT_MESSAGE_FRAGMENTS.some((frag) => messageText.includes(frag))) {
      const { error: updErr } = await supabase
        .from("notification_deliveries")
        .update({
          delivery_status: "skipped",
          error_message: "guard_before_send:placeholder_manager_or_recipient_in_body"
        })
        .eq("id", d.id);
      if (updErr) throw new Error(updErr.message);
      warnings.push(`${d.id}:skipped_placeholder_manager_message`);
      continue;
    }

    if (!isValidAlertRecipientBitrixUserId(d.recipient_bitrix_user_id)) {
      const { error: updErr } = await supabase
        .from("notification_deliveries")
        .update({
          delivery_status: "skipped",
          error_message: "guard_before_send:recipient_bitrix_user_id_missing"
        })
        .eq("id", d.id);
      if (updErr) throw new Error(updErr.message);
      warnings.push(`${d.id}:skipped_missing_recipient`);
      continue;
    }

    // Mirror-only test mode: never send to primary; mirror send is real; primary → skipped.
    if (mode === "mirror_only_test") {
      const mirrorUserId = settings.mirror_bitrix_user_id;
      if (!mirrorUserId) {
        warnings.push(`${d.id}:mirror_bitrix_user_id_missing`);
        continue;
      }

      const mirrorMessage = buildMirrorMessage({
        recipient_name: d.recipient_name,
        recipient_role: d.recipient_role,
        recipient_bitrix_user_id: d.recipient_bitrix_user_id,
        case_id: d.case_id,
        original_message_text: messageText
      });

      const { data: existingMirror, error: exMirErr } = await supabase
        .from("notification_delivery_mirrors")
        .select("id, delivery_status")
        .eq("delivery_id", d.id)
        .eq("mirror_bitrix_user_id", mirrorUserId)
        .maybeSingle();
      if (exMirErr) throw new Error(exMirErr.message);

      if (existingMirror?.delivery_status === "sent") {
        await markPrimarySkippedMirrorOnly(d.id);
        skippedPrimaryDeliveries++;
        continue;
      }

      const mirrorRow = await upsertMirrorRow(supabase, {
        delivery_id: d.id,
        mirror_bitrix_user_id: mirrorUserId,
        message_text: mirrorMessage
      });

      const r = await sendBitrixMessage({
        bitrixUserId: mirrorUserId,
        messageText: mirrorMessage
      });

      if (r.ok) {
        await supabase
          .from("notification_delivery_mirrors")
          .update({
            delivery_status: "sent",
            sent_at: now,
            provider_message_id: r.providerMessageId,
            error_message: null
          })
          .eq("id", mirrorRow.id);
        mirroredDeliveries++;
      } else {
        await supabase
          .from("notification_delivery_mirrors")
          .update({
            delivery_status: "failed",
            error_message: r.errorMessage ?? "mirror_send_failed"
          })
          .eq("id", mirrorRow.id);
        failedMirrors++;
      }

      await markPrimarySkippedMirrorOnly(d.id);
      skippedPrimaryDeliveries++;
      continue;
    }

    // Live mode: send primary
    const sendRes = await sendBitrixMessage({
      bitrixUserId: d.recipient_bitrix_user_id ?? "",
      messageText: messageText
    });

    if (sendRes.ok) {
      const { error: updErr } = await supabase
        .from("notification_deliveries")
        .update({
          delivery_status: "sent",
          sent_at: now,
          provider_message_id: sendRes.providerMessageId,
          error_message: null
        })
        .eq("id", d.id);
      if (updErr) throw new Error(updErr.message);
      sentDeliveries++;
      console.log("[ALERT] delivered", {
        delivery_id: d.id,
        case_id: d.case_id,
        recipient_bitrix_user_id: d.recipient_bitrix_user_id
      });

      if (
        settings.mirror_enabled &&
        settings.mirror_bitrix_user_id &&
        settings.mirror_bitrix_user_id !== d.recipient_bitrix_user_id
      ) {
        const mirrorUserId = settings.mirror_bitrix_user_id;
        const mirrorMessage = buildMirrorMessage({
          recipient_name: d.recipient_name,
          recipient_role: d.recipient_role,
          recipient_bitrix_user_id: d.recipient_bitrix_user_id,
          case_id: d.case_id,
          original_message_text: messageText
        });

        const mirrorRow = await upsertMirrorRow(supabase, {
          delivery_id: d.id,
          mirror_bitrix_user_id: mirrorUserId,
          message_text: mirrorMessage
        });

        if (mirrorRow.delivery_status !== "sent") {
          const mr = await sendBitrixMessage({ bitrixUserId: mirrorUserId, messageText: mirrorMessage });
          if (mr.ok) {
            await supabase
              .from("notification_delivery_mirrors")
              .update({
                delivery_status: "sent",
                sent_at: now,
                provider_message_id: mr.providerMessageId,
                error_message: null
              })
              .eq("id", mirrorRow.id);
            mirroredDeliveries++;
          } else {
            await supabase
              .from("notification_delivery_mirrors")
              .update({
                delivery_status: "failed",
                error_message: mr.errorMessage ?? "mirror_send_failed"
              })
              .eq("id", mirrorRow.id);
            failedMirrors++;
            warnings.push(`${d.id}:mirror_failed:${mr.errorMessage ?? "unknown"}`);
          }
        }
      }
    } else {
      const { error: updErr } = await supabase
        .from("notification_deliveries")
        .update({
          delivery_status: "failed",
          error_message: sendRes.errorMessage ?? "send_failed"
        })
        .eq("id", d.id);
      if (updErr) throw new Error(updErr.message);
      failedDeliveries++;
      console.log("[ALERT] failed", {
        delivery_id: d.id,
        case_id: d.case_id,
        error: sendRes.errorMessage ?? "send_failed"
      });
    }
  }

  return {
    mode,
    scannedDeliveries: (deliveries ?? []).length,
    sentDeliveries,
    failedDeliveries,
    skippedPrimaryDeliveries,
    mirroredDeliveries,
    failedMirrors,
    warnings
  };
}

