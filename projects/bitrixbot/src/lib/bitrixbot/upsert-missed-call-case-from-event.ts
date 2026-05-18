import { createServiceRoleClient } from "@/lib/supabase/server";
import { buildDealDetailsUrl } from "@/src/lib/bitrixbot/deal-enrichment-from-activity";
import {
  getCrmActivityIdForDealMapping,
  isActivityDealMappingConfigured,
  parseBitrixActivityIdForMapping,
  resolveDealMapping,
  type ResolveDealMappingResult
} from "@/src/lib/bitrixbot/activity-deal-mapping";
import { evaluateDealMappingNotificationGate } from "@/src/lib/bitrixbot/missed-call-deal-notification-gate";
import { extractCallContext } from "@/src/lib/bitrixbot/extract-call-context";
import {
  evaluateMissedInboundCustomerCall,
  filterSkipReasonLabel
} from "@/src/lib/bitrixbot/missed-inbound-customer-call";
import { extractVoximplantDataPayload } from "@/src/lib/bitrixbot/voximplant-inbound-missed";
import { lookupEmployeeByBitrixUserId } from "@/src/lib/bitrixbot/employee-lookup";
import { safeJsonTopKeys, safeNestedKeys } from "@/src/lib/bitrixbot/payload-diag";
import { normalizeBitrixUserId } from "@/src/lib/bitrixbot/bitrix-user-id";
import { isSuccessfulContactCall, type SuccessfulContactCallLike } from "@/src/lib/bitrixbot/successful-contact-call";

const LOG = "[alerting:process-missed-calls]";

function dealMappingCaseEnrichmentColumns(m: ResolveDealMappingResult): {
  deal_enrichment_source: string;
  deal_enrichment_confidence: number;
  deal_enrichment_matched_activity_id: number | null;
  deal_enrichment_matched_called_at: string | null;
  deal_enrichment_matched_by_phone: boolean;
  deal_enrichment_phone_manager_matched: boolean;
} {
  if (m.dealId == null || m.source == null || m.confidence == null) {
    throw new Error("dealMappingCaseEnrichmentColumns: expected resolved mapping");
  }
  return {
    deal_enrichment_source: m.source,
    deal_enrichment_confidence: m.confidence,
    deal_enrichment_matched_activity_id: m.matched_bitrix_activity_id,
    deal_enrichment_matched_called_at: m.matched_called_at,
    deal_enrichment_matched_by_phone: m.matched_by_phone ?? false,
    deal_enrichment_phone_manager_matched: m.phone_manager_matched ?? false
  };
}

function dealMappingContextSnapshot(m: ResolveDealMappingResult) {
  return {
    source: m.source,
    confidence: m.confidence,
    matched_bitrix_activity_id: m.matched_bitrix_activity_id,
    matched_called_at: m.matched_called_at,
    matched_by_phone: m.matched_by_phone,
    phone_manager_matched: m.phone_manager_matched,
    multiple_deals_by_phone: m.multiple_deals_by_phone,
    fallback_days: m.fallback_days,
    called_at_from: m.called_at_from
  };
}

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
  call_type_raw: string | null;
  phone_normalized: string | null;
  manager_bitrix_user_id: string | null;
  call_duration_seconds: number | null;
  failed_code: string | null;
  bitrix_deal_id: string | null;
  crm_activity_id: string | number | null;
  bitrix_call_id: string | null;
  raw_payload: unknown;
};

type ProcessingRow = {
  id: string;
  processing_status: "pending" | "processed" | "skipped" | "failed" | "retryable_error";
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
  /** Причина раннего skip по фильтру входящих пропущенных (для агрегата skippedReasons). */
  filterSkipReason?: string | null;
  /** Skip: нет внешнего deal mapping или deal не найден — уведомления не создаём. */
  dealMappingSkipReason?: "deal_mapping_disabled" | "deal_mapping_not_found";
  /** Одно событие без сотрудника в таблице employees — для агрегата в process-new. */
  employeeNotFoundHit?: {
    managerBitrixUserId: string | null;
    callEventId: string;
    phone: string | null;
    occurredAt: string;
    foundInEmployees: boolean;
    foundInHierarchyCache: boolean;
    lookupCandidates: string[];
    rawPayloadTopKeys: string[];
  };
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
  const insertPayload = {
    call_event_id: callEvent.id,
    bitrix_call_id: callEvent.bitrix_call_id,
    processing_status: "pending" as const
  };
  const { data: inserted, error: insErr } = await supabase
    .from("call_event_case_processing")
    .insert(insertPayload)
    .select("id, processing_status, case_id, processing_attempts")
    .maybeSingle();

  if (!insErr && inserted) return inserted as ProcessingRow;

  const code = (insErr as { code?: string } | null)?.code;
  if (code === "23505") {
    const { data: existing, error: selErr } = await supabase
      .from("call_event_case_processing")
      .select("id, processing_status, case_id, processing_attempts")
      .eq("call_event_id", callEvent.id)
      .single();
    if (selErr) supabaseErr("call_event_case_processing.select(after_duplicate)", selErr);
    return existing as ProcessingRow;
  }

  if (insErr) supabaseErr("call_event_case_processing.insert", insErr);
  throw new Error("call_event_case_processing.insert: empty row without error");
}

async function markProcessing(
  supabase: ReturnType<typeof createServiceRoleClient>,
  rowId: string,
  patch: Partial<{
    processing_status: "pending" | "processed" | "skipped" | "failed" | "retryable_error";
    case_id: string | null;
    processed_at: string | null;
    error_message: string | null;
    processing_attempts: number;
  }>
) {
  const { error } = await supabase.from("call_event_case_processing").update(patch).eq("id", rowId);
  if (error) supabaseErr("call_event_case_processing.update(mark)", error);
}

/** Любой успешный звонок по тому же нормализованному номеру между двумя timestamp — обрывает серию пропусков. */
async function hasSuccessfulCallSamePhoneBetween(
  supabase: ReturnType<typeof createServiceRoleClient>,
  phoneNormalized: string,
  afterIso: string,
  beforeIso: string
): Promise<boolean> {
  const t0 = new Date(afterIso).getTime();
  const t1 = new Date(beforeIso).getTime();
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return false;

  const { data, error } = await supabase
    .from("call_events")
    .select(
      "id, status, phone_normalized, manager_bitrix_user_id, call_duration_seconds, failed_code, raw_payload"
    )
    .eq("status", "success")
    .eq("phone_normalized", phoneNormalized)
    .gt("occurred_at", afterIso)
    .lt("occurred_at", beforeIso)
    .order("occurred_at", { ascending: true })
    .limit(40);
  if (error) supabaseErr("call_events.select(success_between)", error);
  for (const row of data ?? []) {
    if (isSuccessfulContactCall(row as SuccessfulContactCallLike)) return true;
  }
  return false;
}

async function findExistingOpenCase(
  supabase: ReturnType<typeof createServiceRoleClient>,
  input: {
    occurredAt: string;
    phoneNormalized: string;
    managerBitrixUserId: string | null;
  }
) {
  const since = minusHours(input.occurredAt, 24);

  const base = supabase
    .from("missed_call_cases")
    .select("id, manager_bitrix_user_id, missed_count, last_missed_at")
    .eq("status", "open")
    .eq("phone_normalized", input.phoneNormalized)
    .gte("last_missed_at", since)
    .order("last_missed_at", { ascending: false })
    .limit(1);

  const withManager = input.managerBitrixUserId
    ? base.eq("manager_bitrix_user_id", input.managerBitrixUserId)
    : base;

  const { data: fallback, error: fbErr } = await withManager.maybeSingle();
  if (fbErr) supabaseErr("missed_call_cases.select(open_case)", fbErr);
  return fallback as { id: string } | null;
}

export async function upsertMissedCallCaseFromEvent(
  callEventId: string,
  diagCtx?: { lastStage: string }
): Promise<UpsertMissedCallCaseResult> {
  const mark = (stage: string, meta?: Record<string, unknown>) => {
    if (diagCtx) diagCtx.lastStage = stage;
    console.log(`${LOG} upsert_stage`, { callEventId, stage, ...meta });
  };

  mark("enter");
  console.log(`${LOG} upsertMissedCallCaseFromEvent enter`, { callEventId });
  const supabase = createServiceRoleClient();
  const warnings: string[] = [];
  let processingRowId: string | null = null;
  let employeeNotFoundHit: UpsertMissedCallCaseResult["employeeNotFoundHit"];

  try {
    mark("call_events_select");
    const { data: callEvent, error: callErr } = await supabase
      .from("call_events")
      .select(
        "id, occurred_at, status, call_direction, call_type_raw, phone_normalized, manager_bitrix_user_id, call_duration_seconds, failed_code, bitrix_deal_id, crm_activity_id, bitrix_call_id, raw_payload"
      )
      .eq("id", callEventId)
      .single();
    if (callErr) supabaseErr("call_events.select(by_id)", callErr);

    const ce = callEvent as CallEventRow;
    mark("call_event_loaded", {
      occurred_at: ce.occurred_at,
      phone_normalized: ce.phone_normalized,
      manager_bitrix_user_id_col: ce.manager_bitrix_user_id,
      manager_normalized: normalizeBitrixUserId(ce.manager_bitrix_user_id),
      raw_payload_top_keys: safeJsonTopKeys(ce.raw_payload)
    });

    mark("call_event_case_processing_get_or_create");
    const processing = await getOrCreateProcessingRow(supabase, ce);
    processingRowId = processing.id;

    if (
      processing.processing_status === "processed" ||
      processing.processing_status === "skipped" ||
      processing.processing_status === "failed"
    ) {
      console.log("[ALERT] duplicate skipped", {
        callEventId,
        processing_status: processing.processing_status,
        case_id: processing.case_id
      });
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

    const inboundEval = evaluateMissedInboundCustomerCall(ce);
    if (!inboundEval.ok) {
      const phoneLog = ce.phone_normalized?.trim() ?? "";
      const data = extractVoximplantDataPayload(ce.raw_payload);
      const fcPayload =
        typeof data.CALL_FAILED_CODE === "string" || typeof data.CALL_FAILED_CODE === "number"
          ? String(data.CALL_FAILED_CODE)
          : "";
      console.log(
        `[missed-call-filter] skip reason=${filterSkipReasonLabel(inboundEval.reason)} callEventId=${ce.id} callType=${inboundEval.callType ?? ce.call_type_raw ?? ""} failedCode=${fcPayload}/${ce.failed_code ?? ""} event=${inboundEval.event ?? ""} phone=${phoneLog} case=none`
      );
      await markProcessing(supabase, processing.id, {
        processing_status: "skipped",
        processed_at: new Date().toISOString(),
        error_message: inboundEval.reason,
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
        error: null,
        filterSkipReason: inboundEval.reason
      };
    }

    console.log("[ALERT] missed incoming detected", {
      callEventId: ce.id,
      phone_normalized: ce.phone_normalized,
      manager_bitrix_user_id: ce.manager_bitrix_user_id,
      occurred_at: ce.occurred_at
    });

    const activityRaw = getCrmActivityIdForDealMapping(ce.crm_activity_id, ce.raw_payload);
    const activityIdNum = parseBitrixActivityIdForMapping(activityRaw);
    console.log(`${LOG} processing_call`, {
      activity_id: activityIdNum,
      manager_id: ce.manager_bitrix_user_id
    });

    const mappingConfigured = isActivityDealMappingConfigured();
    const crmActivityLogForMapping =
      activityRaw ?? (ce.crm_activity_id != null ? String(ce.crm_activity_id) : null);

    let resolvedDealId: number | null = null;
    let mappingResult: ResolveDealMappingResult | null = null;

    if (mappingConfigured) {
      if (activityIdNum == null && (activityRaw ?? "").trim()) {
        console.warn(`${LOG} invalid_activity_id_for_mapping`, { crm_activity_id: activityRaw });
      }
      mappingResult = await resolveDealMapping({
        activityIdNum,
        crm_activity_id: crmActivityLogForMapping,
        phone_normalized: ce.phone_normalized,
        manager_bitrix_user_id: ce.manager_bitrix_user_id
      });
      resolvedDealId = mappingResult.dealId;
      if (resolvedDealId != null) {
        console.log(`${LOG} deal_resolved`, {
          activity_id: activityIdNum,
          deal_id: resolvedDealId,
          source: mappingResult.source,
          confidence: mappingResult.confidence
        });
      } else {
        console.warn(`${LOG} deal_mapping_unresolved`, {
          activity_id: activityIdNum,
          has_phone: Boolean(ce.phone_normalized?.trim())
        });
      }
    } else if (activityIdNum != null) {
      console.warn(`${LOG} deal_mapping_env_missing_skip_lookup`, { activity_id: activityIdNum });
    }

    const dealGate = evaluateDealMappingNotificationGate({
      mappingConfigured,
      resolvedDealId
    });
    if (dealGate.block) {
      const crmActivityLog =
        (activityRaw ?? (ce.crm_activity_id != null ? String(ce.crm_activity_id) : "")).trim() || null;
      const skipPayload = {
        call_event_id: ce.id,
        crm_activity_id: crmActivityLog,
        manager_bitrix_user_id: ce.manager_bitrix_user_id,
        phone_normalized: ce.phone_normalized
      };
      if (dealGate.reason === "deal_mapping_disabled") {
        console.warn(`${LOG} deal_mapping_disabled_skip_notification`, skipPayload);
      } else {
        console.warn(`${LOG} deal_mapping_not_found_skip_notification`, skipPayload);
      }
      await markProcessing(supabase, processing.id, {
        processing_status: "skipped",
        processed_at: new Date().toISOString(),
        error_message: dealGate.reason,
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
        error: null,
        dealMappingSkipReason: dealGate.reason
      };
    }

    if (!mappingResult) {
      throw new Error("internal: mappingResult missing after deal mapping gate");
    }

    const ctx = extractCallContext(ce);

    if (!ctx.phoneNormalized) warnings.push("phone_normalized_missing");

    const phoneNorm = ctx.phoneNormalized ?? ce.phone_normalized ?? "";

    mark("employee_lookup", {
      manager_from_context: ctx.managerBitrixUserId
    });
    const employeeInfo = await lookupEmployeeByBitrixUserId(ctx.managerBitrixUserId);

    if (employeeInfo.issueCode === "manager_bitrix_user_id_missing") {
      warnings.push(
        `manager_bitrix_user_id_missing:call_event_id=${ce.id},phone=${phoneNorm || "null"},occurred_at=${ce.occurred_at},raw_payload_keys=${safeJsonTopKeys(ce.raw_payload).join("|")}`
      );
    } else if (employeeInfo.issueCode === "employee_not_found") {
      const rawKeys = [
        ...safeJsonTopKeys(ce.raw_payload),
        ...safeNestedKeys(ce.raw_payload, ["data"], 25),
        ...safeNestedKeys(ce.raw_payload, ["DATA"], 25)
      ];
      const uniqKeys = [...new Set(rawKeys)].slice(0, 40);
      employeeNotFoundHit = {
        managerBitrixUserId: ctx.managerBitrixUserId,
        callEventId: ce.id,
        phone: phoneNorm || ce.phone_normalized,
        occurredAt: ce.occurred_at,
        foundInEmployees: employeeInfo.foundInEmployees,
        foundInHierarchyCache: employeeInfo.foundInHierarchyCache,
        lookupCandidates: employeeInfo.lookupCandidates,
        rawPayloadTopKeys: uniqKeys
      };
    }
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

    mark("missed_call_cases_find_existing", {
      table: "missed_call_cases",
      strategy: "open+phone+manager+24h",
      phone_normalized: phoneNorm,
      manager_bitrix_user_id: ctx.managerBitrixUserId
    });
    const existing = await findExistingOpenCase(supabase, {
      occurredAt: ce.occurred_at,
      phoneNormalized: phoneNorm,
      managerBitrixUserId: ctx.managerBitrixUserId
    });
    mark("missed_call_cases_find_existing_done", { found: Boolean(existing) });

    let caseId: string;
    let createdCase = false;
    let updatedCase = false;

    if (existing) {
      caseId = existing.id;
      mark("missed_call_cases_select_current", { caseId });
      const { data: cur, error: curErr } = await supabase
        .from("missed_call_cases")
        .select(
          "id, missed_count, last_missed_at, manager_bitrix_user_id, manager_name, contact_name, deal_id, deal_url, deal_title, deal_enriched_at, deal_enrichment_error, deal_enrichment_source, deal_enrichment_confidence, deal_enrichment_matched_activity_id, deal_enrichment_matched_called_at, deal_enrichment_matched_by_phone, deal_enrichment_phone_manager_matched"
        )
        .eq("id", caseId)
        .single();
      if (curErr) supabaseErr("missed_call_cases.select(current)", curErr);

      const current = cur as {
        missed_count: number;
        last_missed_at: string;
        manager_bitrix_user_id: string | null;
        manager_name: string | null;
        contact_name: string | null;
        deal_id: number | null;
        deal_url: string | null;
        deal_title: string | null;
        deal_enriched_at: string | null;
        deal_enrichment_error: string | null;
        deal_enrichment_source: string | null;
        deal_enrichment_confidence: number | null;
        deal_enrichment_matched_activity_id: number | null;
        deal_enrichment_matched_called_at: string | null;
        deal_enrichment_matched_by_phone: boolean | null;
        deal_enrichment_phone_manager_matched: boolean | null;
      };

      mark("missed_call_cases_streak_check", {
        phone_normalized: phoneNorm,
        last_missed_at: current.last_missed_at,
        new_missed_at: ce.occurred_at
      });
      const streakBroken = await hasSuccessfulCallSamePhoneBetween(
        supabase,
        phoneNorm,
        current.last_missed_at,
        ce.occurred_at
      );
      const nextMissedCount = streakBroken ? 1 : (current.missed_count ?? 0) + 1;

      const updatePayload = {
        missed_count: nextMissedCount,
        last_missed_at: ce.occurred_at,
        manager_bitrix_user_id: current.manager_bitrix_user_id ?? ctx.managerBitrixUserId,
        manager_name: current.manager_name ?? employeeInfo.managerName,
        department_id: employeeInfo.departmentId,
        ...(resolvedDealId !== null
          ? {
              deal_id: resolvedDealId,
              deal_url: buildDealDetailsUrl(resolvedDealId),
              deal_title: current.deal_title,
              deal_enriched_at: new Date().toISOString(),
              deal_enrichment_error: null,
              ...dealMappingCaseEnrichmentColumns(mappingResult)
            }
          : {
              deal_id: current.deal_id,
              deal_url: current.deal_url,
              deal_title: current.deal_title,
              deal_enriched_at: current.deal_enriched_at,
              deal_enrichment_error: current.deal_enrichment_error,
              deal_enrichment_source: current.deal_enrichment_source,
              deal_enrichment_confidence: current.deal_enrichment_confidence,
              deal_enrichment_matched_activity_id: current.deal_enrichment_matched_activity_id,
              deal_enrichment_matched_called_at: current.deal_enrichment_matched_called_at,
              deal_enrichment_matched_by_phone: current.deal_enrichment_matched_by_phone,
              deal_enrichment_phone_manager_matched: current.deal_enrichment_phone_manager_matched
            }),
        contact_name: current.contact_name ?? ctx.contactName,
        context: {
          last_call_event_id: ce.id,
          last_bitrix_call_id: ce.bitrix_call_id,
          last_crm_activity_id: ce.crm_activity_id,
          matching_strategy: "phone+manager+24h",
          deal_mapping: dealMappingContextSnapshot(mappingResult)
        }
      };

      mark("missed_call_cases_update", {
        table: "missed_call_cases",
        op: "update",
        filter: "id=eq.case",
        payload_keys: [...Object.keys(updatePayload), "context_keys:" + Object.keys(updatePayload.context).join(",")]
      });

      const { error: upd2Err } = await supabase.from("missed_call_cases").update(updatePayload).eq("id", caseId);
      if (upd2Err) supabaseErr("missed_call_cases.update(existing)", upd2Err);
      updatedCase = true;
      console.log(`[missed-call-case] updated caseId=${caseId} missed_count=${nextMissedCount}`);
    } else {
      const insertPayload = {
        phone_normalized: phoneNorm,
        deal_id: resolvedDealId,
        deal_url: resolvedDealId != null ? buildDealDetailsUrl(resolvedDealId) : null,
        deal_title: null as string | null,
        deal_enriched_at: new Date().toISOString(),
        deal_enrichment_error: null as string | null,
        ...dealMappingCaseEnrichmentColumns(mappingResult),
        contact_name: ctx.contactName,
        manager_bitrix_user_id: ctx.managerBitrixUserId,
        manager_name: employeeInfo.managerName,
        department_id: employeeInfo.departmentId,
        missed_count: 1,
        first_missed_at: ce.occurred_at,
        last_missed_at: ce.occurred_at,
        status: "open" as const,
        context: {
          created_from_call_event_id: ce.id,
          bitrix_call_id: ce.bitrix_call_id,
          crm_activity_id: ce.crm_activity_id,
          matching_strategy: "new_case",
          deal_mapping: dealMappingContextSnapshot(mappingResult)
        }
      };

      mark("missed_call_cases_insert", {
        table: "missed_call_cases",
        op: "insert",
        conflict_target: "none (insert)",
        payload_keys: [...Object.keys(insertPayload), "context_keys:" + Object.keys(insertPayload.context).join(",")]
      });

      const { data: insertedCase, error: insCaseErr } = await supabase
        .from("missed_call_cases")
        .insert(insertPayload)
        .select("id")
        .single();
      if (insCaseErr) supabaseErr("missed_call_cases.insert", insCaseErr);
      caseId = (insertedCase as { id: string }).id;
      createdCase = true;
      console.log(`[missed-call-case] created caseId=${caseId}`);
    }

    mark("call_event_case_processing_mark_processed");
    await markProcessing(supabase, processing.id, {
      processing_status: "processed",
      case_id: caseId,
      processed_at: new Date().toISOString(),
      error_message: null,
      processing_attempts: attempts
    });

    console.log("[ALERT] alert case upserted", {
      callEventId,
      caseId,
      createdCase,
      updatedCase
    });

    return {
      callEventId,
      status: "processed",
      caseId,
      createdCase,
      updatedCase,
      createdDeliveries: 0,
      warnings,
      error: null,
      ...(employeeNotFoundHit ? { employeeNotFoundHit } : {})
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

