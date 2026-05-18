import { createServiceRoleClient } from "@/lib/supabase/server";
import { fetchAllByRange } from "@/src/lib/supabase/fetch-all-by-range";

const PAGE = 800;

/** 1 = календарный день UTC с 00:00; 7 и 30 = скользящее окно назад от сейчас. */
export type AlertingStatisticsPeriodDays = 1 | 7 | 30;

export type AlertingStatisticsSummary = {
  periodDays: AlertingStatisticsPeriodDays;
  periodLabel: string;
  periodStartedAtIso: string;
  totalMissedCasesInPeriod: number;
  openCasesNowTotal: number;
  repeatedSkipsInPeriod: number;
  avgMsToSuccessfulContact: number | null;
  topProblematicManagerName: string | null;
  topProblematicManagerBitrixId: string | null;
  longestOpenCase: {
    case_id: string;
    manager_bitrix_user_id: string | null;
    manager_name: string | null;
    phone_normalized: string;
    last_missed_at: string;
    open_duration_ms: number;
  } | null;
};

export type AlertingManagerStatisticsRow = {
  manager_bitrix_user_id: string;
  manager_name: string | null;
  missed_cases_in_period: number;
  repeated_skips_in_period: number;
  avg_ms_without_contact: number | null;
  open_cases_now: number;
  closed_after_contact_in_period: number;
  escalations_in_period: number;
  problematic_share: number;
  last_problem_at: string | null;
  row_severity: "ok" | "warn" | "danger";
};

export type AlertingStatisticsDashboard = {
  summary: AlertingStatisticsSummary;
  managers: AlertingManagerStatisticsRow[];
  generatedAtIso: string;
};

type CaseInPeriodRow = {
  id: string;
  status: string;
  phone_normalized: string;
  manager_bitrix_user_id: string | null;
  manager_name: string | null;
  missed_count: number;
  last_missed_at: string;
  created_at: string;
  last_successful_callback_at: string | null;
};

type OpenCaseRow = {
  id: string;
  manager_bitrix_user_id: string | null;
  manager_name: string | null;
  phone_normalized: string;
  last_missed_at: string;
};

type DeliveryEscRow = {
  case_id: string | null;
  recipient_role: string | null;
  created_at: string;
};

function periodStartIso(periodDays: AlertingStatisticsPeriodDays): string {
  const now = new Date();
  if (periodDays === 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
    return d.toISOString();
  }
  return new Date(now.getTime() - periodDays * 86_400_000).toISOString();
}

function periodLabel(periodDays: AlertingStatisticsPeriodDays): string {
  if (periodDays === 1) return "Сегодня (UTC)";
  if (periodDays === 7) return "7 дней";
  return "30 дней";
}

function normalizeManagerKey(raw: string | null | undefined): string {
  const s = raw != null ? String(raw).trim() : "";
  return s || "__unassigned__";
}

function contactGapMs(
  c: CaseInPeriodRow,
  nowMs: number
): number | null {
  const lastMissed = new Date(c.last_missed_at).getTime();
  if (!Number.isFinite(lastMissed)) return null;
  const st = String(c.status ?? "").trim();
  if (st === "open") return Math.max(0, nowMs - lastMissed);
  if (st === "resolved_after_contact" && c.last_successful_callback_at) {
    const cb = new Date(c.last_successful_callback_at).getTime();
    if (Number.isFinite(cb)) return Math.max(0, cb - lastMissed);
  }
  return null;
}

const MS_48H = 48 * 60 * 60 * 1000;

function computeRowSeverity(row: {
  repeated_skips_in_period: number;
  open_cases_now: number;
  avg_ms_without_contact: number | null;
}): "ok" | "warn" | "danger" {
  const avg = row.avg_ms_without_contact;
  if (row.repeated_skips_in_period >= 6 || (avg != null && avg >= MS_48H * 2)) return "danger";
  if (row.repeated_skips_in_period >= 3 || row.open_cases_now >= 2 || (avg != null && avg >= MS_48H)) return "warn";
  return "ok";
}

/**
 * Агрегаты по missed_call_cases и notification_deliveries без Bitrix REST.
 */
export async function getAlertingStatisticsDashboard(input: {
  periodDays: AlertingStatisticsPeriodDays;
}): Promise<AlertingStatisticsDashboard> {
  const supabase = createServiceRoleClient();
  const nowMs = Date.now();
  const periodStartedAtIso = periodStartIso(input.periodDays);
  const generatedAtIso = new Date().toISOString();

  const casesInPeriod = await fetchAllByRange<CaseInPeriodRow>({
    pageSize: PAGE,
    fetchPage: (from, to) =>
      supabase
        .from("missed_call_cases")
        .select(
          "id, status, phone_normalized, manager_bitrix_user_id, manager_name, missed_count, last_missed_at, created_at, last_successful_callback_at"
        )
        .gte("last_missed_at", periodStartedAtIso)
        .order("last_missed_at", { ascending: true })
        .range(from, to)
  });

  const openCases = await fetchAllByRange<OpenCaseRow>({
    pageSize: PAGE,
    fetchPage: (from, to) =>
      supabase
        .from("missed_call_cases")
        .select("id, manager_bitrix_user_id, manager_name, phone_normalized, last_missed_at")
        .eq("status", "open")
        .order("last_missed_at", { ascending: true })
        .range(from, to)
  });

  const deliveriesInPeriod = await fetchAllByRange<DeliveryEscRow>({
    pageSize: PAGE,
    fetchPage: (from, to) =>
      supabase
        .from("notification_deliveries")
        .select("case_id, recipient_role, created_at")
        .gte("created_at", periodStartedAtIso)
        .order("created_at", { ascending: true })
        .range(from, to)
  });

  const caseIdToManager = new Map<string, string>();
  for (const c of casesInPeriod) {
    caseIdToManager.set(c.id, normalizeManagerKey(c.manager_bitrix_user_id));
  }

  const escalationRoles = new Set(["rop", "department_director", "company_director"]);
  const escalationsByManager = new Map<string, number>();
  for (const d of deliveriesInPeriod) {
    const role = String(d.recipient_role ?? "").trim();
    if (!escalationRoles.has(role)) continue;
    const cid = d.case_id;
    if (!cid) continue;
    const mgrKey = caseIdToManager.get(cid);
    if (!mgrKey) continue;
    escalationsByManager.set(mgrKey, (escalationsByManager.get(mgrKey) ?? 0) + 1);
  }

  const openCountByManager = new Map<string, number>();
  for (const o of openCases) {
    const k = normalizeManagerKey(o.manager_bitrix_user_id);
    openCountByManager.set(k, (openCountByManager.get(k) ?? 0) + 1);
  }

  const agg = new Map<
    string,
    {
      manager_name: string | null;
      missed_cases_in_period: number;
      repeated_skips_in_period: number;
      gap_sum: number;
      gap_n: number;
      closed_after_contact_in_period: number;
      last_problem_at: string | null;
    }
  >();

  const gapSamples: number[] = [];

  for (const c of casesInPeriod) {
    const k = normalizeManagerKey(c.manager_bitrix_user_id);
    const name = c.manager_name?.trim() ? c.manager_name : null;
    let row = agg.get(k);
    if (!row) {
      row = {
        manager_name: name,
        missed_cases_in_period: 0,
        repeated_skips_in_period: 0,
        gap_sum: 0,
        gap_n: 0,
        closed_after_contact_in_period: 0,
        last_problem_at: null
      };
      agg.set(k, row);
    }
    row.missed_cases_in_period++;
    if ((c.missed_count ?? 0) > 1) row.repeated_skips_in_period++;
    if (name && !row.manager_name) row.manager_name = name;

    const gap = contactGapMs(c, nowMs);
    if (gap != null) {
      row.gap_sum += gap;
      row.gap_n++;
      gapSamples.push(gap);
    }

    if (String(c.status).trim() === "resolved_after_contact") row.closed_after_contact_in_period++;
    const lm = c.last_missed_at;
    if (!row.last_problem_at || lm > row.last_problem_at) row.last_problem_at = lm;
  }

  const avgGlobal =
    gapSamples.length > 0 ? gapSamples.reduce((a, b) => a + b, 0) / gapSamples.length : null;

  let longestOpen: AlertingStatisticsSummary["longestOpenCase"] = null;
  for (const o of openCases) {
    const t0 = new Date(o.last_missed_at).getTime();
    if (!Number.isFinite(t0)) continue;
    const openMs = Math.max(0, nowMs - t0);
    if (!longestOpen || openMs > longestOpen.open_duration_ms) {
      longestOpen = {
        case_id: o.id,
        manager_bitrix_user_id: o.manager_bitrix_user_id,
        manager_name: o.manager_name,
        phone_normalized: o.phone_normalized,
        last_missed_at: o.last_missed_at,
        open_duration_ms: openMs
      };
    }
  }

  const managersRaw: AlertingManagerStatisticsRow[] = [];

  for (const [k, v] of agg) {
    const bitrixId = k === "__unassigned__" ? "—" : k;
    const avgMs = v.gap_n > 0 ? v.gap_sum / v.gap_n : null;
    const total = v.missed_cases_in_period;
    const problematic_share = total > 0 ? v.repeated_skips_in_period / total : 0;
    const openNow = openCountByManager.get(k) ?? 0;
    const esc = escalationsByManager.get(k) ?? 0;

    const base = {
      manager_bitrix_user_id: bitrixId,
      manager_name: k === "__unassigned__" ? "Не назначен" : v.manager_name,
      missed_cases_in_period: v.missed_cases_in_period,
      repeated_skips_in_period: v.repeated_skips_in_period,
      avg_ms_without_contact: avgMs,
      open_cases_now: openNow,
      closed_after_contact_in_period: v.closed_after_contact_in_period,
      escalations_in_period: esc,
      problematic_share,
      last_problem_at: v.last_problem_at
    };
    managersRaw.push({
      ...base,
      row_severity: computeRowSeverity(base)
    });
  }

  managersRaw.sort((a, b) => {
    if (b.open_cases_now !== a.open_cases_now) return b.open_cases_now - a.open_cases_now;
    if (b.repeated_skips_in_period !== a.repeated_skips_in_period)
      return b.repeated_skips_in_period - a.repeated_skips_in_period;
    const avb = b.avg_ms_without_contact ?? 0;
    const ava = a.avg_ms_without_contact ?? 0;
    return avb - ava;
  });

  const top = managersRaw[0];
  const summary: AlertingStatisticsSummary = {
    periodDays: input.periodDays,
    periodLabel: periodLabel(input.periodDays),
    periodStartedAtIso,
    totalMissedCasesInPeriod: casesInPeriod.length,
    openCasesNowTotal: openCases.length,
    repeatedSkipsInPeriod: casesInPeriod.filter((c) => (c.missed_count ?? 0) > 1).length,
    avgMsToSuccessfulContact: avgGlobal,
    topProblematicManagerName: top?.manager_name ?? null,
    topProblematicManagerBitrixId: top && top.manager_bitrix_user_id !== "—" ? top.manager_bitrix_user_id : null,
    longestOpenCase: longestOpen
  };

  return {
    summary,
    managers: managersRaw,
    generatedAtIso
  };
}
