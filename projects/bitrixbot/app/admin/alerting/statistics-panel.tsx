"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AlertingStatisticsDashboard,
  AlertingStatisticsPeriodDays
} from "@/src/lib/bitrixbot/alerting-statistics-dashboard";

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-4">
      <div className="mb-2 text-xs font-medium text-white/70">{title}</div>
      {children}
    </section>
  );
}

function formatDurationMs(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d > 0) return `${d}д ${h % 24}ч`;
  if (h > 0) return `${h}ч ${m % 60}м`;
  if (m > 0) return `${m}м`;
  return `${s}с`;
}

function formatPct(x: number): string {
  if (!Number.isFinite(x)) return "—";
  return `${Math.round(x * 100)}%`;
}

type PeriodKey = AlertingStatisticsPeriodDays;

const PERIOD_TABS: { key: PeriodKey; label: string }[] = [
  { key: 1, label: "Сегодня" },
  { key: 7, label: "7 дней" },
  { key: 30, label: "30 дней" }
];

function periodQueryParam(key: PeriodKey): string {
  if (key === 1) return "today";
  if (key === 30) return "30";
  return "7";
}

export function StatisticsPanel({ secret }: { secret: string }) {
  const [period, setPeriod] = useState<PeriodKey>(7);
  const [dashboard, setDashboard] = useState<AlertingStatisticsDashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const load = useCallback(
    async (p: PeriodKey) => {
      setLoading(true);
      setError(null);
      try {
        const u = new URL("/api/debug/alerting/statistics-dashboard", window.location.origin);
        u.searchParams.set("secret", secret);
        u.searchParams.set("period", periodQueryParam(p));
        const res = await fetch(u.toString());
        const json = (await res.json()) as { ok: boolean; dashboard?: AlertingStatisticsDashboard; error?: string };
        if (!res.ok || !json.ok || !json.dashboard) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        setDashboard(json.dashboard);
      } catch (e) {
        setDashboard(null);
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [secret]
  );

  useEffect(() => {
    void load(period);
  }, [load, period]);

  const filteredManagers = useMemo(() => {
    const rows = dashboard?.managers ?? [];
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) => {
      const id = r.manager_bitrix_user_id.toLowerCase();
      const name = (r.manager_name ?? "").toLowerCase();
      return id.includes(q) || name.includes(q);
    });
  }, [dashboard, search]);

  const s = dashboard?.summary;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center gap-2">
        {PERIOD_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setPeriod(t.key)}
            className={[
              "rounded-lg px-3 py-1.5 text-sm font-medium transition-colors",
              period === t.key
                ? "bg-amber-500/25 text-amber-100 ring-1 ring-amber-400/40"
                : "bg-white/8 text-white/70 hover:bg-white/12"
            ].join(" ")}
          >
            {t.label}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-white/45">
          Окно: <code className="text-white/70">last_missed_at ≥ {s?.periodStartedAtIso ?? "…"}</code> ({s?.periodLabel})
        </span>
      </div>

      <div className="flex flex-wrap gap-2">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Поиск: имя или Bitrix ID…"
          className="min-w-[14rem] flex-1 rounded-lg border border-white/15 bg-black/30 px-3 py-2 text-sm text-white placeholder:text-white/35"
        />
      </div>

      {loading ? (
        <p className="text-sm text-white/55">Загрузка…</p>
      ) : error ? (
        <p className="text-sm text-rose-200/90">{error}</p>
      ) : s && dashboard ? (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <Card title="Пропущенных кейсов (период)">
              <div className="text-xl font-semibold text-white">{s.totalMissedCasesInPeriod}</div>
            </Card>
            <Card title="Открытых сейчас">
              <div className="text-xl font-semibold text-amber-100/90">{s.openCasesNowTotal}</div>
            </Card>
            <Card title="Повторных пропусков (период)">
              <div className="text-xl font-semibold text-amber-100/95">{s.repeatedSkipsInPeriod}</div>
            </Card>
            <Card title="Среднее время до контакта">
              <div className="text-sm font-semibold text-emerald-100/90">
                {formatDurationMs(s.avgMsToSuccessfulContact)}
              </div>
              <div className="mt-1 text-[10px] text-white/45">open + resolved_after_contact в периоде</div>
            </Card>
            <Card title="Топ-1 проблемный">
              <div className="text-sm font-medium text-amber-100/95">
                {s.topProblematicManagerName ?? "—"}
              </div>
              {s.topProblematicManagerBitrixId ? (
                <div className="font-mono text-[11px] text-white/55">{s.topProblematicManagerBitrixId}</div>
              ) : null}
            </Card>
            <Card title="Самый долгий открытый">
              {s.longestOpenCase ? (
                <div className="space-y-0.5 text-xs text-rose-100/90">
                  <div className="font-mono text-[10px] text-white/55">{s.longestOpenCase.case_id}</div>
                  <div>{formatDurationMs(s.longestOpenCase.open_duration_ms)}</div>
                  <div className="text-white/65">{s.longestOpenCase.manager_name ?? "—"}</div>
                </div>
              ) : (
                <div className="text-sm text-white/50">нет</div>
              )}
            </Card>
          </div>

          <Card title="Менеджеры">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] text-left text-xs">
                <thead className="text-white/55">
                  <tr>
                    <th className="py-2 pr-2">Менеджер</th>
                    <th className="py-2 pr-2">Bitrix ID</th>
                    <th className="py-2 pr-2">Кейсов</th>
                    <th className="py-2 pr-2 text-amber-100/80">Повторные</th>
                    <th className="py-2 pr-2">Ср. время без контакта</th>
                    <th className="py-2 pr-2 text-amber-100/80">Открыто</th>
                    <th className="py-2 pr-2 text-emerald-100/80">Закр. контакт</th>
                    <th className="py-2 pr-2">Эскалации</th>
                    <th className="py-2 pr-2">Доля проблем.</th>
                    <th className="py-2">Последняя</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredManagers.map((r) => (
                    <tr
                      key={r.manager_bitrix_user_id}
                      className={[
                        "border-t border-white/10",
                        r.row_severity === "danger"
                          ? "bg-rose-500/10"
                          : r.row_severity === "warn"
                            ? "bg-amber-500/10"
                            : ""
                      ].join(" ")}
                    >
                      <td className="py-2 pr-2 text-white/85">{r.manager_name ?? "—"}</td>
                      <td className="py-2 pr-2 font-mono text-[11px] text-white/70">{r.manager_bitrix_user_id}</td>
                      <td className="py-2 pr-2">{r.missed_cases_in_period}</td>
                      <td className="py-2 pr-2 text-amber-100/90">{r.repeated_skips_in_period}</td>
                      <td className="py-2 pr-2">{formatDurationMs(r.avg_ms_without_contact)}</td>
                      <td className="py-2 pr-2 text-amber-100/90">{r.open_cases_now}</td>
                      <td className="py-2 pr-2 text-emerald-100/85">{r.closed_after_contact_in_period}</td>
                      <td className="py-2 pr-2">{r.escalations_in_period}</td>
                      <td className="py-2 pr-2">{formatPct(r.problematic_share)}</td>
                      <td className="py-2 whitespace-nowrap text-[11px] text-white/65">
                        {r.last_problem_at ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>

          <p className="text-[11px] text-white/40">
            Сгенерировано: {dashboard.generatedAtIso}. Эскалации: доставки с ролью rop / department_director /
            company_director по кейсам в периоде. «Сегодня» — с 00:00 UTC.
          </p>
        </>
      ) : null}
    </div>
  );
}
