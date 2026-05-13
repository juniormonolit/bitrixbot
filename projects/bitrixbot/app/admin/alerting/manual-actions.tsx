"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

export type ManualActionKey =
  | "run_full_cycle"
  | "process_missed_calls"
  | "process_pending_deliveries"
  | "sync_org_full";

const ROUTES: Record<ManualActionKey, string> = {
  run_full_cycle: "/api/internal/alerting/run-full-cycle",
  process_missed_calls: "/api/debug/alerting/process-missed-calls",
  process_pending_deliveries: "/api/debug/alerting/process-pending-deliveries",
  sync_org_full: "/api/debug/alerting/sync-org-full"
};

function errMessageFromJson(json: unknown, status: number): string {
  if (json && typeof json === "object" && json !== null) {
    const o = json as { error?: unknown; message?: unknown };
    if (typeof o.error === "string" && o.error) return o.error;
    if (typeof o.message === "string" && o.message) return o.message;
  }
  return `HTTP ${status}`;
}

export function ManualActions({ debugSecret }: { debugSecret: string }) {
  const router = useRouter();
  const [isRunning, setIsRunning] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<unknown>(null);

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
      const timeoutId = window.setTimeout(() => controller.abort(), 60000);

      try {
        const bodyPayload =
          actionKey === "sync_org_full" ? {} : { limit };
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
            "Запрос превысил лимит ожидания 60 секунд. Проверьте логи сервера и состояние Bitrix."
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
            <option value="sync_org_full">Обновить структуру компании (Bitrix → БД → иерархия)</option>
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
        затем пересобирает кэш руководителей.
      </p>

      {lastError ? (
        <div className="mt-3 rounded-md border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-100">
          {lastError}
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
