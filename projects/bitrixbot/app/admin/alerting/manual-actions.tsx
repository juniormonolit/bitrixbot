"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

export type ManualActionKey =
  | "run_full_cycle"
  | "process_missed_calls"
  | "process_pending_deliveries"
  | "skip_invalid_pending_deliveries"
  | "sync_org_full"
  | "sync_departments"
  | "sync_employees"
  | "rebuild_hierarchy";

const ROUTES: Record<ManualActionKey, string> = {
  run_full_cycle: "/api/internal/alerting/run-full-cycle",
  process_missed_calls: "/api/debug/alerting/process-missed-calls",
  process_pending_deliveries: "/api/debug/alerting/process-pending-deliveries",
  skip_invalid_pending_deliveries: "/api/debug/alerting/skip-invalid-pending-deliveries",
  sync_org_full: "/api/debug/alerting/sync-org-full",
  sync_departments: "/api/debug/alerting/sync-departments",
  sync_employees: "/api/debug/alerting/sync-employees",
  rebuild_hierarchy: "/api/debug/alerting/rebuild-hierarchy"
};

const LONG_SYNC_ACTIONS: ManualActionKey[] = [
  "sync_org_full",
  "sync_departments",
  "sync_employees",
  "rebuild_hierarchy"
];

function errMessageFromJson(json: unknown, status: number): string {
  if (json && typeof json === "object" && json !== null) {
    const o = json as { error?: unknown; message?: unknown };
    if (typeof o.error === "string" && o.error) return o.error;
    if (typeof o.message === "string" && o.message) return o.message;
  }
  return `HTTP ${status}`;
}

function hasActionIssues(lastResult: unknown): boolean {
  if (!lastResult || typeof lastResult !== "object" || lastResult === null) return false;
  const root = lastResult as {
    issuesPresent?: boolean;
    summary?: {
      missedCalls?: {
        ok?: boolean;
        result?: {
          issuesPresent?: boolean;
          failedEvents?: number;
          upsertFailures?: unknown[];
        };
      };
    };
  };
  if (root.issuesPresent === true) return true;
  const mc = root.summary?.missedCalls;
  if (mc && mc.ok === false) return true;
  const r = mc?.result;
  if (!r) return false;
  if (r.issuesPresent === true) return true;
  if (typeof r.failedEvents === "number" && r.failedEvents > 0) return true;
  return false;
}

type MissedCallsSummaryShape = {
  processedEvents?: number;
  skippedEvents?: number;
  skippedReasons?: Record<string, number>;
  recoverableUpsertErrors?: number;
  failedEvents?: number;
  upsertFailures?: unknown[];
  employeeNotFound?: unknown[];
  warnings?: unknown[];
};

function getMissedCallsSummaryFromActionResult(lastResult: unknown): MissedCallsSummaryShape | undefined {
  if (!lastResult || typeof lastResult !== "object" || lastResult === null) return undefined;
  const r = lastResult as {
    summary?: MissedCallsSummaryShape & {
      missedCalls?: { result?: Record<string, unknown> };
    };
  };
  const direct = r.summary;
  if (
    direct &&
    typeof direct === "object" &&
    (typeof direct.processedEvents === "number" ||
      typeof direct.skippedEvents === "number" ||
      (direct.skippedReasons && typeof direct.skippedReasons === "object"))
  ) {
    return direct;
  }
  if (r.summary && typeof r.summary.failedEvents === "number") {
    return r.summary;
  }
  const inner = r.summary?.missedCalls?.result;
  if (inner && typeof inner === "object") {
    return inner as MissedCallsSummaryShape;
  }
  return undefined;
}

export function ManualActions({ debugSecret }: { debugSecret: string }) {
  const router = useRouter();
  const [isRunning, setIsRunning] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<unknown>(null);

  const resultIssues = hasActionIssues(lastResult);
  const sum = getMissedCallsSummaryFromActionResult(lastResult);

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const form = e.currentTarget;
      const fd = new FormData(form);
      const actionKey = String(fd.get("manual_action") ?? "") as ManualActionKey;
      const limit = Math.max(1, Math.min(5000, Number(fd.get("limit") ?? 100) || 100));

      const url = ROUTES[actionKey];
      if (!url) {
        setLastError("Неизвестное действие");
        return;
      }

      setIsRunning(true);
      setLastError(null);
      setLastResult(null);

      const controller = new AbortController();
      const clientTimeoutMs = LONG_SYNC_ACTIONS.includes(actionKey) ? 130_000 : 60_000;
      const timeoutId = window.setTimeout(() => controller.abort(), clientTimeoutMs);

      try {
        const bodyPayload =
          LONG_SYNC_ACTIONS.includes(actionKey) ? {} : { limit };
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-debug-secret": debugSecret
          },
          body: JSON.stringify(bodyPayload),
          signal: controller.signal
        });

        const json: unknown = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error(errMessageFromJson(json, res.status));
        }
        setLastResult(json);
        router.refresh();
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") {
          setLastError(
            `Запрос превысил лимит ожидания ${clientTimeoutMs / 1000} с. Проверьте логи сервера и состояние Bitrix.`
          );
        } else {
          setLastError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        window.clearTimeout(timeoutId);
        setIsRunning(false);
      }
    },
    [debugSecret, router]
  );

  return (
    <div>
      <form onSubmit={onSubmit} className="flex flex-col gap-3 md:flex-row md:items-end">
        <div className="flex-1">
          <div className="text-sm text-white/70">Действие</div>
          <select
            name="manual_action"
            className="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm"
            defaultValue="run_full_cycle"
          >
            <option value="run_full_cycle">Запустить полный цикл</option>
            <option value="process_missed_calls">Обработать новые missed calls</option>
            <option value="process_pending_deliveries">Отправить pending deliveries</option>
            <option value="skip_invalid_pending_deliveries">
              Пометить skipped: невалидные pending deliveries
            </option>
            <option value="sync_org_full">Обновить структуру компании (Bitrix → БД → иерархия)</option>
            <option value="sync_departments">Только: синхрон отделов из Bitrix</option>
            <option value="sync_employees">Только: синхрон сотрудников из Bitrix</option>
            <option value="rebuild_hierarchy">Только: пересборка org_resolved_hierarchy</option>
          </select>
        </div>
        <div className="w-40">
          <div className="text-sm text-white/70">Limit</div>
          <input
            name="limit"
            type="number"
            min={1}
            max={5000}
            defaultValue={100}
            className="mt-1 w-full rounded-md border border-white/10 bg-black/20 px-3 py-2 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={isRunning}
          className="rounded-md bg-white/10 px-4 py-2 text-sm hover:bg-white/15 disabled:opacity-60"
        >
          {isRunning ? "Запуск..." : "Запустить"}
        </button>
      </form>

      <p className="mt-2 text-xs text-white/50">
        Полный цикл: пересборка иерархии из БД → missed calls → callback → SLA → pending deliveries
        (sender учитывает kill switch, dry run, mirror-only). Обновление структуры тянет сотрудников из Bitrix,
        затем пересобирает кэш руководителей. «Невалидные pending»: пустой/0 получатель, плейсхолдеры «Не назначен» в
        тексте, или created_at старше 30 минут — поле Limit задаёт размер партии обновления за один запрос.
      </p>

      {lastError ? (
        <div className="mt-3 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
          {lastError}
        </div>
      ) : null}

      {typeof sum?.processedEvents === "number" || typeof sum?.skippedEvents === "number" ? (
        <div className="mt-3 rounded-md border border-white/10 bg-white/[0.06] px-3 py-2 text-xs leading-relaxed text-white/75">
          Missed calls: processed={String(sum?.processedEvents ?? "—")}, skipped={String(sum?.skippedEvents ?? "—")}
          , skippedReasons=
          <code className="text-emerald-100/85">{JSON.stringify(sum?.skippedReasons ?? {})}</code>
          {typeof sum?.recoverableUpsertErrors === "number" && sum.recoverableUpsertErrors > 0 ? (
            <span>
              , recoverableUpsertErrors=
              <span className="text-amber-100/90">{String(sum.recoverableUpsertErrors)}</span>
            </span>
          ) : null}
        </div>
      ) : null}

      {resultIssues ? (
        <div className="mt-3 rounded-md border border-amber-400/45 bg-amber-500/15 px-3 py-2 text-sm leading-relaxed text-amber-50">
          Запрос завершился с предупреждениями:{" "}
          <span className="font-medium">failedEvents={String(sum?.failedEvents ?? "—")}</span>
          {Array.isArray(sum?.upsertFailures) ? (
            <span className="font-medium">
              , upsertFailures={sum?.upsertFailures.length}
              {typeof sum?.recoverableUpsertErrors === "number" && sum.recoverableUpsertErrors > 0
                ? ` (retryable=${sum.recoverableUpsertErrors})`
                : ""}
            </span>
          ) : null}
          {Array.isArray(sum?.employeeNotFound) ? (
            <span className="font-medium">, employeeNotFound_groups={sum?.employeeNotFound.length}</span>
          ) : null}
          . В JSON: для отдельного «missed calls» — <code className="text-amber-100/90">summary.*</code>; для
          полного цикла — <code className="text-amber-100/90">summary.missedCalls.result.*</code>.
        </div>
      ) : null}

      {lastResult !== null ? (
        <details className="mt-3 rounded-md border border-white/10 bg-black/25">
          <summary className="cursor-pointer px-3 py-2 text-xs text-white/70">
            Результат (JSON)
          </summary>
          <pre className="max-h-96 overflow-auto border-t border-white/10 p-3 text-xs text-white/80">
            {JSON.stringify(lastResult, null, 2)}
          </pre>
        </details>
      ) : null}
    </div>
  );
}
