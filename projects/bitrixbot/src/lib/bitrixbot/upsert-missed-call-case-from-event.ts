import { createServiceRoleClient } from "@/lib/supabase/server";
import { buildDealUrl } from "@/src/lib/bitrixbot/build-deal-url";
import { extractCallContext } from "@/src/lib/bitrixbot/extract-call-context";
import { isMissedInboundCallEvent } from "@/src/lib/bitrixbot/is-missed-inbound-call-event";
import { lookupEmployeeByBitrixUserId } from "@/src/lib/bitrixbot/employee-lookup";
import { prepareNotificationsForMissedCallCase } from "@/src/lib/bitrixbot/prepare-notifications-for-missed-call-case";

const LOG = "[alerting:process-missed-calls]";

function supabaseErr(
  ctx: string,
  err: { message: string; details?: string | null; hint?: string | null; code?: string | null }
): never {
  const parts = [err.message];
  if (err.details) parts.push(`details=${err.details}`);
  if (err.hint) parts.push(`hint=${err.hint}`);
  if (err.code) parts.push(`code=${err.code}`);
  throw new Error(`${ctx}: ${parts.join(" | ")}`);
}

type CallEventRow = {
  id: string;
  occurred_at: string;
  status: string;
  call_direction: string | null;
  phone_normalized: string | null;
  manager_bitrix_user_id: string | null;
  bitrix_deal_id: string | null;
  crm_activity_id: string | null;
  bitrix_call_id: string | null;
  raw_payload: unknown;
};

type ProcessingRow = {
  id: string;
  processing_status: "pending" | "processed" | "skipped" | "failed";
  case_id: string | null;
  processing_attempts: number;
};

export type UpsertMissedCallCaseResult = {
  callEventId: string;
  status: "processed" | "skipped" | "failed" | "noop";
  caseId: string | null;
  createdCase: boolean;
  updatedCase: boolean;
  createdDeliveries: number;
  warnings: string[];
  error: string | null;
};

function minusHours(iso: string, hours: number): string {
  const t = new Date(iso).getTime();
  const shifted = new Date(t - hours * 60 * 60 * 1000);
  return shifted.toISOString();
}

async function getOrCreateProcessingRow(
  supabase: ReturnType<typeof createServiceRoleClient>,
  callEvent: CallEventRow
): Promise<ProcessingRow> {
  const { data: existing, error: selErr } = await supabase
    .from("call_event_case_processing")
    .select("id, processing_status, case_id, processing_attempts")
    .eq("call_event_id", callEvent.id)
    .maybeSingle();
  if (selErr) supabaseErr("call_event_case_processing.select(existing)", selErr);
  if (existing) return existing as ProcessingRow;

  const { data: inserted, error: insErr } = await supabase
    .from("call_event_case_processing")
    .insert({
      call_event_id: callEvent.id,
      bitrix_call_id: callEvent.bitrix_call_id,
      processing_status: "pending"
    })
    .select("id, processing_status, case_id, processing_attempts")
    .single();
  if (insErr) supabaseErr("call_event_case_processing.insert", insErr);
  return inserted as ProcessingRow;
}

async function markProcessing(
  supabase: ReturnType<typeof createServiceRoleClient>,
  rowId: string,
  patch: Partial<{
    processing_status: "pending" | "processed" | "skipped" | "failed";
    case_id: string | null;
    processed_at: string | null;
    error_message: string | null;
    processing_attempts: number;
  }>
) {
  const { error } = await supabase.from("call_event_case_processing").update(patch).eq("id", rowId);
  if (error) supabaseErr("call_event_case_processing.update(mark)", error);
}

async function findExistingOpenCase(
  supabase: ReturnType<typeof createServiceRoleClient>,
  input: {
    occurredAt: string;
    phoneNormalized: string;
    managerBitrixUserId: string | null;
    dealId: number | null;
  }
) {
  // Strategy:
  // 1) Try strict match with deal_id if we have it.
  // 2) Fallback to phone + manager + 24h window (deal_id may be unavailable).
  const since = minusHours(input.occurredAt, 24);

  const base = supabase
    .from("missed_call_cases")
    .select("id, deal_id, manager_bitrix_user_id, missed_count, last_missed_at")
    .eq("status", "open")
    .eq("phone_normalized", input.phoneNormalized)
    .gte("last_missed_at", since)
    .order("last_missed_at", { ascending: false })
    .limit(1);

  const withManager = input.managerBitrixUserId
    ? base.eq("manager_bitrix_user_id", input.managerBitrixUserId)
    : base;

  if (input.dealId !== null) {
    const { data, error } = await withManager.eq("deal_id", input.dealId).maybeSingle();
    if (error) supabaseErr("missed_call_cases.select(deal_match)", error);
    if (data) return data as { id: string };
  }

  const { data: fallback, error: fbErr } = await withManager.maybeSingle();
  if (fbErr) supabaseErr("missed_call_cases.select(fallback)", fbErr);
  return fallback as { id: string } | null;
}

export async function upsertMissedCallCaseFromEvent(
  callEventId: string
): Promise<UpsertMissedCallCaseResult> {
  console.log(`${LOG} upsertMissedCallCaseFromEvent enter`, { callEventId });
  const supabase = createServiceRoleClient();
  const warnings: string[] = [];
  let processingRowId: string | null = null;

  try {
    const { data: callEvent, error: callErr } = await supabase
      .from("call_events")
      .select(
        "id, occurred_at, status, call_direction, phone_normalized, manager_bitrix_user_id, bitrix_deal_id, crm_activity_id, bitrix_call_id, raw_payload"
      )
      .eq("id", callEventId)
      .single();
    if (callErr) supabaseErr("call_events.select(by_id)", callErr);

    const ce = callEvent as CallEventRow;
    const processing = await getOrCreateProcessingRow(supabase, ce);
    processingRowId = processing.id;

    if (processing.processing_status === "processed" || processing.processing_status === "skipped") {
      return {
        callEventId,
        status: "noop",
        caseId: processing.case_id,
        createdCase: false,
        updatedCase: false,
        createdDeliveries: 0,
        warnings,
        error: null
      };
    }

    const attempts = (processing.processing_attempts ?? 0) + 1;

    if (!isMissedInboundCallEvent(ce)) {
      await markProcessing(supabase, processing.id, {
        processing_status: "skipped",
        processed_at: new Date().toISOString(),
        error_message: null,
        processing_attempts: attempts
      });
      return {
        callEventId,
        status: "skipped",
        caseId: null,
        createdCase: false,
        updatedCase: false,
        createdDeliveries: 0,
        warnings,
        error: null
      };
    }

    if (!ce.phone_normalized) {
      warnings.push("phone_normalized_missing");
    }

    const ctx = extractCallContext(ce);
    if (!ctx.phoneNormalized) warnings.push("phone_normalized_missing");

    const employeeInfo = await lookupEmployeeByBitrixUserId(ctx.managerBitrixUserId);
    if (employeeInfo.warning) warnings.push(employeeInfo.warning);

    const phoneNorm = ctx.phoneNormalized ?? ce.phone_normalized ?? "";
    if (!phoneNorm) {
      await markProcessing(supabase, processing.id, {
        processing_status: "failed",
        processed_at: new Date().toISOString(),
        error_message: "phone_normalized is required to create a case",
        processing_attempts: attempts
      });
      return {
        callEventId,
        status: "failed",
        caseId: null,
        createdCase: false,
        updatedCase: false,
        createdDeliveries: 0,
        warnings,
        error: "phone_normalized is required to create a case"
      };
    }

    const existing = await findExistingOpenCase(supabase, {
      occurredAt: ce.occurred_at,
      phoneNormalized: phoneNorm,
      managerBitrixUserId: ctx.managerBitrixUserId,
      dealId: ctx.dealId
    });

    let caseId: string;
    let createdCase = false;
    let updatedCase = false;

    if (existing) {
      caseId = existing.id;
      const { data: cur, error: curErr } = await supabase
        .from("missed_call_cases")
        .select(
          "id, missed_count, manager_bitrix_user_id, manager_name, deal_id, deal_url, contact_name"
        )
        .eq("id", caseId)
        .single();
      if (curErr) supabaseErr("missed_call_cases.select(current)", curErr);

      const current = cur as {
        missed_count: number;
        manager_bitrix_user_id: string | null;
        manager_name: string | null;
        deal_id: number | null;
        deal_url: string | null;
        contact_name: string | null;
      };

      const nextDealId = current.deal_id ?? ctx.dealId;
      const nextDealUrl = current.deal_url ?? buildDealUrl(nextDealId);

      const { error: upd2Err } = await supabase
        .from("missed_call_cases")
        .update({
          missed_count: (current.missed_count ?? 0) + 1,
          last_missed_at: ce.occurred_at,
          manager_bitrix_user_id: current.manager_bitrix_user_id ?? ctx.managerBitrixUserId,
          manager_name: current.manager_name ?? employeeInfo.managerName,
          department_id: employeeInfo.departmentId,
          deal_id: nextDealId,
          deal_url: nextDealUrl,
          contact_name: current.contact_name ?? ctx.contactName,
          context: {
            last_call_event_id: ce.id,
            last_bitrix_call_id: ce.bitrix_call_id,
            last_crm_activity_id: ce.crm_activity_id,
            matching_strategy: ctx.dealId !== null ? "phone+manager+deal+24h" : "phone+manager+24h"
          }
        })
        .eq("id", caseId);
      if (upd2Err) supabaseErr("missed_call_cases.update(existing)", upd2Err);
      updatedCase = true;
    } else {
      const dealUrl = buildDealUrl(ctx.dealId);
      const { data: insertedCase, error: insCaseErr } = await supabase
        .from("missed_call_cases")
        .insert({
          phone_normalized: phoneNorm,
          deal_id: ctx.dealId,
          deal_url: dealUrl,
          contact_name: ctx.contactName,
          manager_bitrix_user_id: ctx.managerBitrixUserId,
          manager_name: employeeInfo.managerName,
          department_id: employeeInfo.departmentId,
          missed_count: 1,
          first_missed_at: ce.occurred_at,
          last_missed_at: ce.occurred_at,
          status: "open",
          context: {
            created_from_call_event_id: ce.id,
            bitrix_call_id: ce.bitrix_call_id,
            crm_activity_id: ce.crm_activity_id,
            matching_strategy: "new_case"
          }
        })
        .select("id")
        .single();
      if (insCaseErr) supabaseErr("missed_call_cases.insert", insCaseErr);
      caseId = (insertedCase as { id: string }).id;
      createdCase = true;
    }

    await markProcessing(supabase, processing.id, {
      processing_status: "processed",
      case_id: caseId,
      processed_at: new Date().toISOString(),
      error_message: null,
      processing_attempts: attempts
    });

    let createdDeliveries = 0;
    try {
      const prep = await prepareNotificationsForMissedCallCase(caseId);
      createdDeliveries = prep.createdDeliveriesCount;
      warnings.push(...prep.warnings);
    } catch (prepErr) {
      warnings.push(
        `prepare_notifications_failed:${prepErr instanceof Error ? prepErr.message : String(prepErr)}`
      );
    }

    return {
      callEventId,
      status: "processed",
      caseId,
      createdCase,
      updatedCase,
      createdDeliveries,
      warnings,
      error: null
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);

    try {
      if (processingRowId) {
        // Best-effort mark failure; do not hide original error
        const { data: cur } = await supabase
          .from("call_event_case_processing")
          .select("processing_attempts")
          .eq("id", processingRowId)
          .maybeSingle();
        const attempts = ((cur as { processing_attempts?: number } | null)?.processing_attempts ?? 0) + 1;

        await markProcessing(supabase, processingRowId, {
          processing_status: "failed",
          processed_at: new Date().toISOString(),
          error_message: msg,
          processing_attempts: attempts
        });
      }
    } catch {
      // ignore
    }

    return {
      callEventId,
      status: "failed",
      caseId: null,
      createdCase: false,
      updatedCase: false,
      createdDeliveries: 0,
      warnings,
      error: msg
    };
  }
}

