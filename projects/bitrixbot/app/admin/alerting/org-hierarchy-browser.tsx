"use client";

import { useMemo, useState } from "react";

export type OrgHierarchyRow = {
  id: string;
  manager_bitrix_user_id: string;
  manager_name: string | null;
  department_name: string | null;
  rop_bitrix_user_id: string | null;
  rop_name: string | null;
  director_bitrix_user_id: string | null;
  director_name: string | null;
  resolved_at: string;
};

export type OrgHierarchyStats = {
  total: number;
  withRop: number;
  withoutRop: number;
  withDirector: number;
  withoutDirector: number;
};

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-white/10 bg-white/5 p-5">
      <div className="mb-3 text-sm font-medium text-white/80">{title}</div>
      {children}
    </section>
  );
}

export function OrgHierarchyBrowser(props: { rows: OrgHierarchyRow[]; stats: OrgHierarchyStats }) {
  const [q, setQ] = useState("");
  const [ropFilter, setRopFilter] = useState<"all" | "yes" | "no">("all");
  const [dirFilter, setDirFilter] = useState<"all" | "yes" | "no">("all");

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    return props.rows.filter((r) => {
      if (t) {
        const hay = [
          r.manager_bitrix_user_id,
          r.manager_name ?? "",
          r.rop_bitrix_user_id ?? "",
          r.rop_name ?? "",
          r.director_bitrix_user_id ?? "",
          r.director_name ?? "",
          r.department_name ?? ""
        ]
          .join(" ")
          .toLowerCase();
        if (!hay.includes(t)) return false;
      }
      if (ropFilter === "yes" && !r.rop_bitrix_user_id) return false;
      if (ropFilter === "no" && r.rop_bitrix_user_id) return false;
      if (dirFilter === "yes" && !r.director_bitrix_user_id) return false;
      if (dirFilter === "no" && r.director_bitrix_user_id) return false;
      return true;
    });
  }, [props.rows, q, ropFilter, dirFilter]);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-5">
        <div className="rounded-md border border-white/10 bg-black/20 p-2">
          <div className="text-[10px] text-white/45">Всего в кэше</div>
          <div className="text-lg font-semibold">{props.stats.total}</div>
        </div>
        <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 p-2">
          <div className="text-[10px] text-emerald-100/80">С РОПом</div>
          <div className="text-lg font-semibold text-emerald-100">{props.stats.withRop}</div>
        </div>
        <div className="rounded-md border border-amber-400/25 bg-amber-500/10 p-2">
          <div className="text-[10px] text-amber-100/80">Без РОПа</div>
          <div className="text-lg font-semibold text-amber-100">{props.stats.withoutRop}</div>
        </div>
        <div className="rounded-md border border-emerald-500/20 bg-emerald-500/10 p-2">
          <div className="text-[10px] text-emerald-100/80">С директором</div>
          <div className="text-lg font-semibold text-emerald-100">{props.stats.withDirector}</div>
        </div>
        <div className="rounded-md border border-amber-400/25 bg-amber-500/10 p-2">
          <div className="text-[10px] text-amber-100/80">Без директора</div>
          <div className="text-lg font-semibold text-amber-100">{props.stats.withoutDirector}</div>
        </div>
      </div>

      <Card title="Поиск и фильтры">
        <div className="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-end">
          <label className="flex min-w-[12rem] flex-1 flex-col text-xs text-white/50">
            Имя или Bitrix id
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="mt-1 rounded-md border border-white/10 bg-black/25 px-3 py-2 text-sm text-white"
              placeholder="например 1954 или Смирнов"
            />
          </label>
          <label className="flex flex-col text-xs text-white/50">
            РОП
            <select
              value={ropFilter}
              onChange={(e) => setRopFilter(e.target.value as typeof ropFilter)}
              className="mt-1 rounded-md border border-white/10 bg-black/25 px-3 py-2 text-sm text-white"
            >
              <option value="all">все</option>
              <option value="yes">есть РОП</option>
              <option value="no">нет РОПа</option>
            </select>
          </label>
          <label className="flex flex-col text-xs text-white/50">
            Директор
            <select
              value={dirFilter}
              onChange={(e) => setDirFilter(e.target.value as typeof dirFilter)}
              className="mt-1 rounded-md border border-white/10 bg-black/25 px-3 py-2 text-sm text-white"
            >
              <option value="all">все</option>
              <option value="yes">есть директор</option>
              <option value="no">нет директора</option>
            </select>
          </label>
          <div className="text-xs text-white/45">
            Показано строк:{" "}
            <span className="font-mono text-white/80">
              {filtered.length}/{props.rows.length}
            </span>
          </div>
        </div>
      </Card>

      <Card title="Менеджер → РОП → директор (org_resolved_hierarchy)">
        <div className="max-h-[min(70vh,720px)] overflow-auto">
          <table className="w-full min-w-[56rem] text-left text-xs">
            <thead className="sticky top-0 z-[1] bg-zinc-900/95 text-white/60">
              <tr>
                <th className="py-2 pr-2">Менеджер Bitrix ID</th>
                <th className="py-2 pr-2">Менеджер</th>
                <th className="py-2 pr-2">Отдел</th>
                <th className="py-2 pr-2">РОП Bitrix ID</th>
                <th className="py-2 pr-2">РОП</th>
                <th className="py-2 pr-2">Директор Bitrix ID</th>
                <th className="py-2 pr-2">Директор</th>
                <th className="py-2">resolved_at</th>
              </tr>
            </thead>
            <tbody className="text-white/85">
              {filtered.map((r) => (
                <tr key={r.id} className="border-t border-white/10 align-top">
                  <td className="py-2 pr-2 font-mono">{r.manager_bitrix_user_id}</td>
                  <td className="max-w-[10rem] py-2 pr-2 [overflow-wrap:anywhere]">{r.manager_name ?? "—"}</td>
                  <td className="max-w-[10rem] py-2 pr-2 [overflow-wrap:anywhere]">{r.department_name ?? "—"}</td>
                  <td className="py-2 pr-2 font-mono text-[11px]">{r.rop_bitrix_user_id ?? "—"}</td>
                  <td className="max-w-[10rem] py-2 pr-2 [overflow-wrap:anywhere]">{r.rop_name ?? "—"}</td>
                  <td className="py-2 pr-2 font-mono text-[11px]">{r.director_bitrix_user_id ?? "—"}</td>
                  <td className="max-w-[10rem] py-2 pr-2 [overflow-wrap:anywhere]">{r.director_name ?? "—"}</td>
                  <td className="whitespace-nowrap py-2 text-[10px] text-white/50">{r.resolved_at}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
