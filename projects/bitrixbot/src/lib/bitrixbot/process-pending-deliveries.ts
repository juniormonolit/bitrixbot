import { createServiceRoleClient } from "@/lib/supabase/server";
import { withTimeout } from "@/src/lib/bitrixbot/async-timeout";
import { getAlertingSettings } from "@/src/lib/bitrixbot/get-alerting-settings";
import {
  maybeReenrichCaseBeforeSend,
  refreshPendingDeliveryMessageDealLine
} from "@/src/lib/bitrixbot/re-enrich-case-deal";
import { sendBitrixMessage } from "@/src/lib/bitrixbot/send-bitrix-message";

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
  const { data: deliveries, error } = await supabase
    .from("notification_deliveries")
    .select(
      "id, case_id, rule_id, recipient_role, recipient_bitrix_user_id, recipient_name, message_text, delivery_status, created_at"
    )
    .eq("delivery_status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
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
      const quick = await withTimeout(maybeReenrichCaseBeforeSend(supabase, d.case_id), 2500, `re_enrich:${d.case_id}`);
      if (quick.attempted && !quick.chosen) {
        warnings.push(`re_enrich_no_deal:${d.case_id}`);
      }
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      warnings.push(`re_enrich_timeout_or_error:${d.case_id}:${m}`);
    }
    try {
      const patched = await refreshPendingDeliveryMessageDealLine(supabase, d.id, d.case_id);
      if (patched.updated) {
        warnings.push(`delivery_deal_line_patched:${d.id}`);
        const { data: dFresh } = await supabase
          .from("notification_deliveries")
          .select("message_text")
          .eq("id", d.id)
          .maybeSingle();
        if (dFresh && typeof (dFresh as { message_text?: string }).message_text === "string") {
          messageText = (dFresh as { message_text: string }).message_text;
        }
      }
    } catch {
      warnings.push(`delivery_deal_line_patch_failed:${d.id}`);
    }

    if (!d.recipient_bitrix_user_id && mode === "live") {
      const { error: updErr } = await supabase
        .from("notification_deliveries")
        .update({ delivery_status: "failed", error_message: "Recipient Bitrix user id is missing" })
        .eq("id", d.id);
      if (updErr) throw new Error(updErr.message);
      failedDeliveries++;
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

